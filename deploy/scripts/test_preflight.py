import tempfile
from pathlib import Path
import unittest
import socket
from preflight import validate_environment,load_environment,published_bindings,probe_binding

class PreflightTests(unittest.TestCase):
    def values(self):return {"HOME_TUNNEL_CONSOLE_HOST":"console.home.test","HOME_TUNNEL_TUNNEL_DOMAIN":"home.test","HOME_TUNNEL_PUBLIC_BASE_URL":"https://console.home.test","HOME_TUNNEL_FRPS_PUBLIC_HOST":"frps.home.test"}
    def test_origin_and_injection_rejected(self):
        self.assertEqual(validate_environment(self.values()),[])
        for address in ['http://console.home.test','https://user@console.home.test','https://console.home.test/redirect','https://elsewhere.test']:
            self.assertTrue(validate_environment({**self.values(),'HOME_TUNNEL_PUBLIC_BASE_URL':address}))
    def test_port_overlap_and_oversized_pools_rejected(self):
        for start,end in [('443','444'),('1','200'),('7000','7000'),('5000','4000')]:
            self.assertTrue(validate_environment({**self.values(),'HOME_TUNNEL_TCP_PORT_START':start,'HOME_TUNNEL_TCP_PORT_END':end}))
    def test_environment_is_data_never_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'.env';path.write_text('HOME_TUNNEL_VALUE="$(touch should-not-exist)"\n',encoding='utf-8')
            self.assertEqual(load_environment(path)['HOME_TUNNEL_VALUE'],'$(touch should-not-exist)')
            self.assertFalse((path.parent/'should-not-exist').exists())

    def test_effective_overlays_expand_tcp_and_udp_pools(self):
        config={'services':{'frps':{'ports':[
            {'host_ip':'127.0.0.1','published':'12000-12002','protocol':'tcp'},
            {'published':'12000-12002','protocol':'udp'},
            {'target':8080},
        ]}}}
        ports=published_bindings(config)
        self.assertEqual(len(ports),6)
        self.assertIn(('127.0.0.1',12002,'tcp'),ports)
        self.assertIn(('0.0.0.0',12000,'udp'),ports)
        for invalid in ['0','65536','100-99','1-102','invalid']:
            with self.assertRaises(ValueError):published_bindings({'services':{'test':{'ports':[{'published':invalid}]}}})
    def test_in_use_tcp_and_udp_are_not_reported_available(self):
        for protocol,kind in [('tcp',socket.SOCK_STREAM),('udp',socket.SOCK_DGRAM)]:
            with socket.socket(socket.AF_INET,kind) as occupied:
                occupied.bind(('127.0.0.1',0))
                with self.assertRaises(OSError):probe_binding('127.0.0.1',occupied.getsockname()[1],protocol)

if __name__=='__main__':unittest.main()
