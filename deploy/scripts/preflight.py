#!/usr/bin/env python3
"""Read-only deployment checks. Never print environment values or credentials."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]

def load_environment(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"): continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key): raise ValueError("Unsupported .env line; use KEY=value")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'": value=value[1:-1]
        values[key] = value
    return values

def validate_environment(values):
    errors=[]
    hostname=re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",re.I)
    for key in ("HOME_TUNNEL_CONSOLE_HOST","HOME_TUNNEL_TUNNEL_DOMAIN"):
        value=values.get(key,"")
        if not hostname.fullmatch(value) or value.endswith("example.com"): errors.append(f"{key}: set a real DNS name")
    origin=urlsplit(values.get("HOME_TUNNEL_PUBLIC_BASE_URL",""))
    if origin.scheme!="https" or origin.hostname!=values.get("HOME_TUNNEL_CONSOLE_HOST") or origin.path not in ("","/") or origin.username or origin.query or origin.fragment:
        errors.append("HOME_TUNNEL_PUBLIC_BASE_URL: use the HTTPS console origin without credentials or a path")
    try:
        port=int(values.get("HOME_TUNNEL_FRPS_PORT","7000"))
        if port not in range(1,65536) or port in (80,443):raise ValueError()
    except ValueError:errors.append("HOME_TUNNEL_FRPS_PORT: choose a free port in 1–65535, different from 80/443")
    for prefix in ("TCP","UDP","L4","MANAGED"):
        keys=[f"HOME_TUNNEL_{prefix}_PORT_START",f"HOME_TUNNEL_{prefix}_PORT_END"]
        if not any(key in values for key in keys):continue
        try:
            start,end=[int(values[key]) for key in keys]
            if not 1<=start<=end<=65535 or end-start>99:raise ValueError()
            if any(start<=port<=end for port in (80,443,int(values.get("HOME_TUNNEL_FRPS_PORT","7000")))):raise ValueError()
        except (ValueError,KeyError):errors.append(f"{prefix} pool: choose at most 100 ports without overlapping 80, 443 or FRPS")
    frps=values.get("HOME_TUNNEL_FRPS_PUBLIC_HOST","")
    try:
        ip=ipaddress.ip_address(frps)
        if not ip.is_global:errors.append("HOME_TUNNEL_FRPS_PUBLIC_HOST: use a publicly reachable address or DNS name")
    except ValueError:
        if not hostname.fullmatch(frps):errors.append("HOME_TUNNEL_FRPS_PUBLIC_HOST: invalid host")
    return errors

def published_bindings(configuration):
    """Read effective Compose ports, including selected overlays, without logging secrets."""
    bindings=set()
    for service in configuration.get('services',{}).values():
        for mapping in service.get('ports',[]):
            if not isinstance(mapping,dict):raise ValueError('Unsupported Compose port format')
            if 'published' not in mapping:continue
            protocol=mapping.get('protocol','tcp')
            if protocol not in ('tcp','udp'):raise ValueError('Unsupported port protocol')
            address=mapping.get('host_ip') or '0.0.0.0'
            ipaddress.ip_address(address)
            match=re.fullmatch(r'(\d+)(?:-(\d+))?',str(mapping['published']))
            if not match:raise ValueError('Invalid published port')
            start=int(match[1]);end=int(match[2] or match[1])
            if not 1<=start<=end<=65535 or end-start>99:raise ValueError('A published range must contain 1–100 ports')
            for port in range(start,end+1):bindings.add((address,port,protocol))
    return sorted(bindings)

def probe_binding(address,port,protocol):
    family=socket.AF_INET6 if ipaddress.ip_address(address).version==6 else socket.AF_INET
    kind=socket.SOCK_STREAM if protocol=='tcp' else socket.SOCK_DGRAM
    with socket.socket(family,kind) as probe:
        if family==socket.AF_INET6:probe.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
        probe.bind((address,port))

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,default=ROOT)
    parser.add_argument("--existing",action="store_true",help="Validate an existing deployment without reserving its published ports")
    parser.add_argument("--expected-ip",help="Expected public DNS address; optional")
    parser.add_argument("--skip-network",action="store_true",help="Explicitly skip DNS checks, useful for offline preparation")
    parser.add_argument("--json",action="store_true")
    parser.add_argument("-f","--file",action="append",default=[],help="Compose overlay, relative to deployment root")
    args=parser.parse_args(argv);root=args.root.resolve();checks=[];bindings=None
    def record(name,status,detail):checks.append({"check":name,"status":status,"detail":detail})
    try:values=load_environment(root/".env")
    except (OSError,ValueError) as error:record("configuration","failed",str(error));values={}
    if values:
        errors=validate_environment(values);record("configuration","failed" if errors else "passed","; ".join(errors) if errors else "Deployment fields are valid")
    try:
        with tempfile.NamedTemporaryFile(prefix=".preflight-",dir=root): pass
        free=shutil.disk_usage(root).free
        record("storage","passed" if free>=2*1024**3 else "failed","Directory writable; at least 2 GiB free" if free>=2*1024**3 else "Need at least 2 GiB free")
    except OSError:record("storage","failed","Deployment directory is not writable")
    secret_root=root/"deploy/secrets"
    names=["internal_service_key","frps_plugin_key","lease_signing_key","bootstrap_admin_password","frps_tls_cert.pem","frps_tls_key.pem"]
    missing=[name for name in names if not (secret_root/name).is_file() or (secret_root/name).stat().st_size==0]
    record("secrets","failed" if missing else "passed","Missing secret files: "+", ".join(missing) if missing else "Required secret files exist; contents were not printed")
    if os.name=="posix" and secret_root.exists() and secret_root.stat().st_mode & 0o077:record("secret-permissions","failed","chmod 700 deploy/secrets; keep files readable by container UID 10001")
    if shutil.which("docker"):
        env={**os.environ,**values}
        for label,command in [("docker",["docker","info","--format","{{.OSType}}"]),("compose",["docker","compose","version","--short"]),("compose-config",["docker","compose","-f","compose.yaml",*[part for file in args.file for part in ("-f",file)],"config","--format","json"])]:
            try:
                result=subprocess.run(command,cwd=root,env=env,capture_output=True,text=True,timeout=30,check=False)
                ok=result.returncode==0 and (label!="docker" or result.stdout.strip()=="linux")
                record(label,"passed" if ok else "failed","Available and valid" if ok else "Check Docker Linux engine, Compose v2, selected overlays and required environment fields")
                if label=='compose-config' and ok:
                    try:bindings=published_bindings(json.loads(result.stdout))
                    except (ValueError,TypeError):record('port-mappings','failed','Cannot validate published ports; check protocols, addresses and ranges of at most 100 ports')
            except (OSError,subprocess.TimeoutExpired):record(label,"failed","Command unavailable or timed out")
    else:record("docker","failed","Install Docker Engine and Compose v2")
    if not args.existing:
        if bindings is None:record('published-ports','skipped','Resolve Compose configuration before checking its published ports')
        else:
            for address,port,protocol in bindings:
                try:
                    probe_binding(address,port,protocol)
                    record(f"port-{port}-{protocol}","passed","Local bind available; verify cloud firewall and router separately")
                except OSError:record(f"port-{port}-{protocol}","failed","Port in use, address unavailable or bind permission denied; check existing reverse proxy/NAS services")
    if args.skip_network:record("dns","skipped","DNS checks explicitly skipped")
    elif values and not validate_environment(values):
        socket.setdefaulttimeout(5)
        expected=str(ipaddress.ip_address(args.expected_ip)) if args.expected_ip else None
        for label,host in [("console-dns",values["HOME_TUNNEL_CONSOLE_HOST"]),("wildcard-dns",f"preflight-{secrets.token_hex(4)}.{values['HOME_TUNNEL_TUNNEL_DOMAIN']}"),("frps-dns",values["HOME_TUNNEL_FRPS_PUBLIC_HOST"])]:
            try:
                addresses={str(ipaddress.ip_address(entry[4][0])) for entry in socket.getaddrinfo(host,None)}
                ok=bool(addresses) and (not expected or expected in addresses)
                record(label,"passed" if ok else "failed","DNS resolves to the expected address" if expected and ok else "DNS resolves; compare A/AAAA with the server's public addresses" if ok else "DNS does not include --expected-ip")
            except OSError:record(label,"failed","DNS lookup failed; check A/AAAA and wildcard records, disable HTTP proxying for FRPS")
    failed=any(item["status"]=="failed" for item in checks)
    if args.json:print(json.dumps({"passed":not failed,"checks":checks},ensure_ascii=False,indent=2))
    else:
        for item in checks:print(f"[{item['status']}] {item['check']}: {item['detail']}")
        print("Next: verify public firewall rules, then docker compose up -d. Local checks do not prove inbound Internet reachability.")
    return 1 if failed else 0

if __name__=="__main__":raise SystemExit(main())
