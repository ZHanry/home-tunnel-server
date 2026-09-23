import importlib.util
from pathlib import Path
import socket
import struct
import threading
import unittest

spec=importlib.util.spec_from_file_location('stun_probe',Path(__file__).with_name('probe-stun.py'))
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)

class StunProbeTests(unittest.TestCase):
    def test_response_transaction_and_required_address(self):
        transaction=b'012345678901'
        body=struct.pack('!HHBBHI',0x0020,8,0,1,3478^0x2112,0x7f000001^probe.COOKIE)
        self.assertTrue(probe.validate_binding(probe.request(0x0101,transaction,body),transaction))
        with self.assertRaises(ValueError):probe.validate_binding(probe.request(0x0101,b'ABCDEFGHIJKL',body),transaction)
        with self.assertRaises(ValueError):probe.validate_binding(probe.request(0x0101,transaction),transaction)

    def test_loopback_fixture_binding_and_allocate_rejection(self):
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as listener:
            listener.bind(('127.0.0.1',0));listener.settimeout(2)
            def respond():
                for index in range(3):
                    data,address=listener.recvfrom(512);transaction=data[8:20]
                    body=struct.pack('!HHBBHI',0x0020,8,0,1,address[1]^0x2112,0x7f000001^probe.COOKIE) if index==0 else b''
                    listener.sendto(probe.request(0x0101 if index==0 else (struct.unpack('!H',data[:2])[0] | 0x0110),transaction,body),address)
            worker=threading.Thread(target=respond);worker.start()
            result=probe.probe('127.0.0.1',listener.getsockname()[1]);worker.join(timeout=3)
            self.assertEqual(result['binding'],'passed');self.assertFalse(result['public_media_relay_tested'])

    def test_mapped_address_does_not_hide_malformed_trailing_attributes(self):
        transaction=b'012345678901'
        mapped=probe.attribute(0x0020,struct.pack('!BBHI',0,1,3478^0x2112,0x7f000001^probe.COOKIE))
        for body in (mapped+struct.pack('!HH',0x8028,100), mapped+mapped,
                     probe.attribute(0x0020,bytes([0,2])+bytes(6))):
            with self.assertRaises(ValueError):
                probe.validate_binding(probe.request(0x0101,transaction,body),transaction)

    def test_any_successful_turn_request_blocks_the_probe(self):
        for method,label in ((3,'Allocate'),(4,'Refresh'),(8,'CreatePermission'),(9,'ChannelBind')):
            with self.subTest(method=method), socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as listener, socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as client:
                listener.bind(('127.0.0.1',0));listener.settimeout(2)
                client.connect(listener.getsockname());client.settimeout(1)
                def respond():
                    data,address=listener.recvfrom(512)
                    listener.sendto(probe.request(method | 0x0100,data[8:20]),address)
                worker=threading.Thread(target=respond);worker.start()
                try:
                    with self.assertRaisesRegex(ValueError,label):
                        probe.expect_rejected(client,method,label)
                finally:
                    worker.join(timeout=3)

if __name__=='__main__':unittest.main()
