"""Probe a specified STUN-only UDP endpoint without sending media or user data."""
import argparse
import json
import os
import socket
import struct

COOKIE=0x2112A442

def request(message_type,transaction,attributes=b''):
    return struct.pack('!HHI12s',message_type,len(attributes),COOKIE,transaction)+attributes

def validate_binding(data,transaction):
    if len(data)<20:raise ValueError('Truncated STUN response')
    kind,size,cookie,received=struct.unpack('!HHI12s',data[:20])
    if kind!=0x0101 or cookie!=COOKIE or received!=transaction or size!=len(data)-20:raise ValueError('Invalid Binding response')
    position=20
    while position+4<=len(data):
        attr,length=struct.unpack('!HH',data[position:position+4]);position+=4
        if position+length>len(data):raise ValueError('Invalid STUN attribute length')
        if attr==0x0020 and length in (8,20):return True
        position+=(length+3)&~3
    raise ValueError('Binding did not include XOR-MAPPED-ADDRESS')

def probe(host,port=3478,timeout=2):
    info=socket.getaddrinfo(host,port,type=socket.SOCK_DGRAM)[0]
    with socket.socket(info[0],socket.SOCK_DGRAM) as udp:
        udp.settimeout(timeout);udp.connect(info[4])
        transaction=os.urandom(12);udp.send(request(0x0001,transaction))
        validate_binding(udp.recv(2048),transaction)
        # REQUESTED-TRANSPORT: UDP. A successful Allocate would violate policy.
        transaction=os.urandom(12);udp.send(request(0x0003,transaction,struct.pack('!HHBBBB',0x0019,4,17,0,0,0)))
        try:
            data=udp.recv(2048)
            if len(data)>=20 and data[8:20]==transaction and struct.unpack('!H',data[:2])[0]==0x0103:
                raise ValueError('TURN Allocate succeeded; do not enable RD on this deployment')
        except socket.timeout:pass
    return {'binding':'passed','turn_allocate':'rejected_or_dropped','transport':'udp','public_media_relay_tested':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('host');parser.add_argument('--port',type=int,default=3478)
    args=parser.parse_args();print(json.dumps(probe(args.host,args.port)))
