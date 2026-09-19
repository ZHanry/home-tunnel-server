#!/usr/bin/env python3
"""Verify a restored bundle and import into a NEW Compose project and empty volume."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess

def verify(bundle):
    manifest=json.loads((bundle/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format')!=1 or manifest.get('version')!='7.0.0':raise ValueError('Use the matching 7.0.0 restore tool')
    entries=manifest.get('files',[])
    if not 1<=len(entries)<=64:raise ValueError('Invalid file manifest')
    names=set()
    for item in entries:
        name=item['path'];relative=PurePosixPath(name)
        if name in names or relative.is_absolute() or '..' in relative.parts or '\\' in name or (name!='database.sqlite3' and not name.startswith('config/')):raise ValueError('Unsafe backup path')
        names.add(name);path=bundle.joinpath(*relative.parts)
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(bundle.resolve()):raise ValueError('Backup path escapes bundle')
        with path.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
        if path.stat().st_size!=item['size'] or digest!=item['sha256']:raise ValueError('Backup checksum mismatch')
    for path in bundle.rglob('*'):
        if path.is_symlink():raise ValueError('Symbolic links are forbidden')
        if path.is_file() and path.relative_to(bundle).as_posix()!='manifest.json' and path.relative_to(bundle).as_posix() not in names:raise ValueError('Unlisted backup file')
    required={'database.sqlite3','config/.env','config/compose.yaml','config/deploy/caddy/Caddyfile.selfhost'} | {'config/deploy/secrets/'+name for name in ['internal_service_key','frps_plugin_key','lease_signing_key','bootstrap_admin_password','frps_tls_cert.pem','frps_tls_key.pem']}
    if not required.issubset(names):raise ValueError('Incomplete deployment bundle')
    with sqlite3.connect((bundle/'database.sqlite3').resolve().as_uri()+'?mode=ro',uri=True) as database:
        if database.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or database.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('SQLite validation failed')
        if database.execute('SELECT max(version) FROM schema_migrations').fetchone()[0]!=12:raise ValueError('Schema mismatch')
        if database.execute("SELECT count(*) FROM users WHERE role='admin' AND deleted_at IS NULL").fetchone()[0]!=1:raise ValueError('Administrator singleton invalid')
    return manifest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--destination',type=Path)
    parser.add_argument('--project',help='New Docker Compose project name')
    parser.add_argument('--verify-only',action='store_true')
    args=parser.parse_args();bundle=args.bundle.resolve();verify(bundle)
    if args.verify_only:print('Manifest, complete configuration, SQLite integrity and administrator verified');return
    if not args.destination or not args.project or not re.fullmatch(r'[a-z][a-z0-9-]{2,48}',args.project):raise SystemExit('Specify an empty --destination and a new lowercase --project')
    destination=args.destination.absolute()
    if destination.is_symlink() or destination==destination.parent or (destination.exists() and any(destination.iterdir())):raise SystemExit('Destination must be an empty real directory')
    volume=args.project+'_sqlite-data'
    listed=subprocess.run(['docker','volume','ls','--format','{{.Name}}'],check=True,text=True,capture_output=True).stdout.splitlines()
    if volume in listed:raise SystemExit('Target database volume already exists; existing data is never replaced')
    if os.name=='posix':os.umask(0o077)
    shutil.copytree(bundle/'config',destination,dirs_exist_ok=True)
    (destination/'deploy/downloads').mkdir(parents=True,exist_ok=True)
    env=destination/'.env'
    lines=[line for line in env.read_text(encoding='utf-8').splitlines() if not line.startswith('COMPOSE_PROJECT_NAME=')]
    env.write_text('\n'.join(lines)+f'\nCOMPOSE_PROJECT_NAME={args.project}\n',encoding='utf-8')
    if os.name=='posix':
        (destination/'deploy/secrets').chmod(0o700)
        for file in (destination/'deploy/secrets').iterdir():file.chmod(0o644)
    subprocess.run(['docker','volume','create',volume],check=True,capture_output=True)
    # The target is a newly created Docker volume. No existing volume is erased.
    # Stream the verified file as the host owner, without a privileged host bind.
    # Set permissions before transferring ownership: CHOWN does not imply FOWNER.
    # Transfer the directory last so root can still traverse its owner-only mode.
    with (bundle/'database.sqlite3').open('rb') as source:
        subprocess.run(['docker','run','--rm','-i','--network','none','--cap-drop','ALL','--cap-add','CHOWN',
            '--mount',f'type=volume,source={volume},target=/target',
            'alpine:3.23','sh','-ec','test -z "$(ls -A /target)"; cat > /target/home-tunnel.db; chmod 700 /target; chmod 600 /target/home-tunnel.db; chown 10001:10001 /target/home-tunnel.db; chown 10001:10001 /target'],stdin=source,check=True)
    print('Restored into a new project. Inspect .env and DNS, then start from the destination with docker compose up -d. Login, device reconnection and public tunnel checks must follow.')

if __name__=='__main__':main()
