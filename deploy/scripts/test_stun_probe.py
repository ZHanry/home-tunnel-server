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
                for index in range(2):
                    data,address=listener.recvfrom(512);transaction=data[8:20]
                    body=struct.pack('!HHBBHI',0x0020,8,0,1,address[1]^0x2112,0x7f000001^probe.COOKIE) if index==0 else b''
                    listener.sendto(probe.request(0x0101 if index==0 else 0x0113,transaction,body),address)
            worker=threading.Thread(target=respond);worker.start()
            result=probe.probe('127.0.0.1',listener.getsockname()[1]);worker.join(timeout=3)
            self.assertEqual(result['binding'],'passed');self.assertFalse(result['public_media_relay_tested'])

if __name__=='__main__':unittest.main()
