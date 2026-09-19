#!/usr/bin/env python3
"""Interactive standard Compose setup; never replaces existing configuration."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
from preflight import ROOT, validate_environment

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain");parser.add_argument("--frps-host");parser.add_argument("--console-host");parser.add_argument("--email")
    parser.add_argument("--write",action="store_true",help="Generate .env and deployment secrets using the existing generator")
    args=parser.parse_args()
    domain=args.domain or input("Tunnel domain (e.g. tunnel.your-domain.net): ").strip()
    frps=args.frps_host or input("Public server IP or FRPS DNS name: ").strip()
    console=args.console_host or "console."+domain
    email=args.email or input("ACME certificate email: ").strip()
    values={"HOME_TUNNEL_TUNNEL_DOMAIN":domain,"HOME_TUNNEL_CONSOLE_HOST":console,"HOME_TUNNEL_PUBLIC_BASE_URL":"https://"+console,"HOME_TUNNEL_FRPS_PUBLIC_HOST":frps}
    errors=validate_environment(values)
    if errors:raise SystemExit("\n".join(errors))
    if "@" not in email or any(c.isspace() for c in email):raise SystemExit("Invalid email")
    print(f"Console: https://{console}\nWildcard DNS: *.{domain}\nFRPS: {frps}:7000\nRequired ports: TCP 80/443/7000, UDP 443")
    if not args.write:
        print("Review these values, then repeat with --write to generate configuration. No files were changed.");return
    if (ROOT/".env").exists() or (ROOT/"deploy/secrets").exists():raise SystemExit("Configuration already exists; refusing to replace secrets")
    if os.name=="nt":
        shell=shutil.which("pwsh")
        if not shell:raise SystemExit("PowerShell 7 is required on Windows")
        command=[shell,"-NoProfile","-File",str(ROOT/"deploy/scripts/new-selfhost-config.ps1"),"-TunnelDomain",domain,"-FrpsPublicHost",frps,"-ConsoleHost",console,"-AcmeEmail",email]
    else:command=["sh",str(ROOT/"deploy/scripts/new-selfhost-config.sh"),domain,frps,console,email]
    subprocess.run(command,cwd=ROOT,check=True)
    print("Run python3 deploy/scripts/preflight.py before starting containers. Keep the bootstrap password private.")

if __name__=="__main__":main()
