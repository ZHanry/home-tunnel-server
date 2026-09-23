"""Probe a specified STUN-only UDP endpoint without sending media or user data."""
import argparse
import ipaddress
import json
import os
import socket
import struct
import time

COOKIE = 0x2112A442


def request(message_type, transaction, attributes=b''):
    return struct.pack('!HHI12s', message_type, len(attributes), COOKIE, transaction) + attributes


def attribute(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + bytes((-len(value)) % 4)


def response(data, transaction):
    if len(data) < 20:
        raise ValueError('Truncated STUN response')
    kind, size, cookie, received = struct.unpack('!HHI12s', data[:20])
    if cookie != COOKIE or received != transaction or size != len(data) - 20 or size % 4:
        raise ValueError('Invalid STUN response header')
    attributes, position = [], 20
    while position < len(data):
        if position + 4 > len(data):
            raise ValueError('Truncated STUN attribute')
        attr, length = struct.unpack('!HH', data[position:position + 4])
        position += 4
        end = position + ((length + 3) & ~3)
        if end > len(data):
            raise ValueError('Invalid STUN attribute length')
        attributes.append((attr, data[position:position + length]))
        position = end
    return kind, attributes


def validate_binding(data, transaction):
    kind, attributes = response(data, transaction)
    if kind != 0x0101:
        raise ValueError('Invalid Binding response')
    mapped = [value for attr, value in attributes if attr == 0x0020]
    if len(mapped) != 1:
        raise ValueError('Binding must include exactly one XOR-MAPPED-ADDRESS')
    value = mapped[0]
    if len(value) not in (8, 20) or value[0] != 0 or (value[1], len(value)) not in ((1, 8), (2, 20)):
        raise ValueError('Invalid XOR-MAPPED-ADDRESS')
    return True


def expect_rejected(udp, method, label, attributes=b''):
    transaction = os.urandom(12)
    udp.send(request(method, transaction, attributes))
    deadline = time.monotonic() + udp.gettimeout()
    while time.monotonic() < deadline:
        udp.settimeout(max(0.001, deadline - time.monotonic()))
        try:
            data = udp.recv(2048)
        except socket.timeout:
            return 'dropped'
        if len(data) >= 20 and data[8:20] != transaction:
            continue
        kind, _ = response(data, transaction)
        if kind != (method | 0x0110):
            raise ValueError(f'TURN {label} was not rejected; do not enable RD on this deployment')
        return 'rejected'
    return 'dropped'


def probe(host, port=3478, timeout=2):
    info = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)[0]
    with socket.socket(info[0], socket.SOCK_DGRAM) as udp:
        udp.settimeout(timeout)
        udp.connect(info[4])
        transaction = os.urandom(12)
        udp.send(request(0x0001, transaction))
        validate_binding(udp.recv(2048), transaction)
        allocate = expect_rejected(udp, 3, 'Allocate', attribute(0x0019, bytes([17, 0, 0, 0])))
        udp.settimeout(timeout)
        refresh = expect_rejected(udp, 4, 'Refresh', attribute(0x000D, struct.pack('!I', 60)))
    return {'binding': 'passed', 'turn_allocate': allocate, 'turn_refresh': refresh,
            'transport': 'udp', 'public_media_relay_tested': False}


def probe_local_relay(port=3478, timeout=0.3):
    """Only for a server in this same isolated IPv4 loopback network namespace."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sink, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        sink.bind(('127.0.0.1', 0))
        sink.settimeout(timeout)
        udp.connect(('127.0.0.1', port))
        udp.settimeout(timeout)
        peer = attribute(0x0012, struct.pack('!BBHI', 0, 1, sink.getsockname()[1] ^ (COOKIE >> 16),
                                           int(ipaddress.ip_address('127.0.0.1')) ^ COOKIE))
        permission = expect_rejected(udp, 8, 'CreatePermission', peer)
        udp.settimeout(timeout)
        channel = attribute(0x000C, struct.pack('!HH', 0x4000, 0))
        binding = expect_rejected(udp, 9, 'ChannelBind', channel + peer)
        marker = b'home-tunnel-stun-only-probe'
        udp.send(request(0x0016, os.urandom(12), peer + attribute(0x0013, marker)))
        udp.send(struct.pack('!HH', 0x4000, len(marker)) + marker)
        try:
            sink.recv(2048)
        except socket.timeout:
            pass
        else:
            raise ValueError('TURN Send or ChannelData reached the local sink')
    return {'turn_create_permission': permission, 'turn_channel_bind': binding,
            'send_and_channel_data': 'not_forwarded_to_isolated_local_sink'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    parser.add_argument('--port', type=int, default=3478)
    args = parser.parse_args()
    print(json.dumps(probe(args.host, args.port)))
