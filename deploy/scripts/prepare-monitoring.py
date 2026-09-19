#!/usr/bin/env python3
import json
import os
import secrets
from preflight import ROOT,load_environment,validate_environment

def main():
    values=load_environment(ROOT/'.env')
    errors=validate_environment(values)
    if errors:raise SystemExit('\n'.join(errors))
    directory=ROOT/'deploy/monitoring'
    generated=(directory/'prometheus.yml.template').read_text(encoding='utf-8').replace('__CONSOLE_URL__',json.dumps(values['HOME_TUNNEL_PUBLIC_BASE_URL']))
    (directory/'prometheus.generated.yml').write_text(generated,encoding='utf-8')
    secret=ROOT/'deploy/secrets/grafana_admin_password'
    if not secret.exists():
        with secret.open('x',encoding='utf-8') as file:file.write(secrets.token_urlsafe(36)+'\n')
        if os.name=='posix':secret.chmod(0o644)
    print('Monitoring configured. Password remains in deploy/secrets/grafana_admin_password. Grafana binds only to 127.0.0.1:3000.')

if __name__=='__main__':main()
