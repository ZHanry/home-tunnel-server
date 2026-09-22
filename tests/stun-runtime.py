"""Exercise the deployment's real coturn and nftables in an isolated namespace.

Requires Linux, Docker, sudo, nsenter and nft. No host firewall is changed and
no port is published. This is runtime evidence, not a public-network load test.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stun_probe', ROOT / 'deploy/scripts/probe-stun.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def run(*args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=60, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {(result.stdout + result.stderr)[-3000:]}')
    return result.stdout.strip()


def namespace_checks(firewall):
    report = probe.probe('127.0.0.1', timeout=0.3)
    report.update(probe.probe_local_relay())
    for port in (3478, 5349):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp:
            tcp.settimeout(0.3)
            if tcp.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError(f'Unexpected TCP listener on {port}')
    report['tcp_and_tls_listeners'] = 'absent'
    if firewall:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.connect(('127.0.0.1', 3478))
            udp.settimeout(0.2)
            transactions = {os.urandom(12) for _ in range(60)}
            for transaction in transactions:
                udp.send(probe.request(1, transaction))
            received = set()
            while True:
                try:
                    data = udp.recv(2048)
                except socket.timeout:
                    break
                if data[8:20] in transactions:
                    probe.validate_binding(data, data[8:20])
                    received.add(data[8:20])
            if not 0 < len(received) < len(transactions):
                raise RuntimeError('Bounded Binding burst did not demonstrate rate limiting')
        rules = json.loads(run('nft', '-j', 'list', 'table', 'inet', 'home_tunnel_stun'))
        drops = sum(next((expr['counter']['packets'] for expr in row.get('rule', {}).get('expr', []) if 'counter' in expr), 0)
                    for row in rules['nftables'] if any('drop' in expr for expr in row.get('rule', {}).get('expr', [])))
        if not drops:
            raise RuntimeError('Firewall did not count rejected packets')
        report['bounded_burst'] = {'sent': len(transactions), 'received': len(received), 'drop_counter': drops}
    return report


def main(output):
    if sys.platform != 'linux':
        raise RuntimeError('This real deployment test requires Linux; no simulated success is available')
    overlay = (ROOT / 'deploy/compose.stun.yaml').read_text()
    match = re.search(r'^\s+image:\s+(coturn/coturn:[^\s]+@sha256:[0-9a-f]{64})\s*$', overlay, re.M)
    if not match:
        raise RuntimeError('STUN image must have a sealed multi-platform digest')
    image = match.group(1)
    name = 'home-tunnel-stun-test-' + uuid.uuid4().hex[:12]
    report = {'schema_version': 1, 'status': 'failed', 'scope': 'isolated Linux network namespace',
              'public_network': 'not_verified', 'image': image,
              'repository_revision': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
              'source_modified': bool(run('git', '-C', str(ROOT), 'status', '--porcelain')),
              'source_sha256': {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest()
                                for file in ('deploy/stun/turnserver.conf', 'deploy/stun/firewall.nft', 'deploy/scripts/probe-stun.py')}}
    started = False
    try:
        # --network none ensures that the probe cannot contact another host.
        run('docker', 'run', '-d', '--name', name, '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '--memory', '64m',
            '--cpus', '0.20', '--pids-limit', '32', '--tmpfs', '/tmp:size=8m,noexec,nosuid,nodev',
            '-v', str(ROOT / 'deploy/stun/turnserver.conf') + ':/etc/coturn/turnserver.conf:ro',
            image, '-c', '/etc/coturn/turnserver.conf')
        started = True
        for _ in range(30):
            state = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', name))
            if not state['Running']:
                logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, timeout=10)
                report['container_exit'] = {key: state[key] for key in ('ExitCode', 'OOMKilled', 'Error')}
                raise RuntimeError('Coturn stopped: ' + (logs.stdout + logs.stderr)[-3000:])
            health = subprocess.run(['docker', 'exec', name, 'turnutils_stunclient', '-p', '3478', '127.0.0.1'],
                                    capture_output=True, timeout=6)
            if health.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError('Deployment healthcheck never passed')
        ns = ['sudo', 'nsenter', '-t', str(state['Pid']), '-n', '--']
        report['coturn_without_firewall'] = json.loads(run(*ns, sys.executable, str(Path(__file__).resolve()), '--namespace-probe'))
        run(*ns, 'nft', '-c', '-f', str(ROOT / 'deploy/stun/firewall.nft'))
        run(*ns, 'nft', '-f', str(ROOT / 'deploy/stun/firewall.nft'))
        report['coturn_with_firewall'] = json.loads(run(*ns, sys.executable, str(Path(__file__).resolve()), '--namespace-probe', '--firewall'))
        report['status'] = 'passed'
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n')
        if started:
            run('docker', 'rm', '-f', name)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--namespace-probe', action='store_true')
    parser.add_argument('--firewall', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'outputs/stun-runtime.json')
    args = parser.parse_args()
    if args.namespace_probe:
        print(json.dumps(namespace_checks(args.firewall)))
    else:
        main(args.output)
