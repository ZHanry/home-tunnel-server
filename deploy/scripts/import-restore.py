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
import tempfile
from contextlib import closing

def supported_schema():
    migrations=Path(__file__).resolve().parents[2]/'control-center/migrations'
    versions=[int(path.name.split('_')[0]) for path in migrations.glob('[0-9]*_*.sql')]
    if not versions:raise ValueError('Restore tool requires the migration files shipped with its release')
    return max(versions)

def verify(bundle):
    manifest=json.loads((bundle/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format')!=1 or not re.fullmatch(r'\d+\.\d+\.\d+(?:-rc\.\d+)?',str(manifest.get('version',''))):raise ValueError('Unsupported backup manifest version')
    entries=manifest.get('files',[])
    if not 1<=len(entries)<=128:raise ValueError('Invalid file manifest')
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
    with closing(sqlite3.connect((bundle/'database.sqlite3').resolve().as_uri()+'?mode=ro',uri=True)) as database:
        if database.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or database.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('SQLite validation failed')
        schema=database.execute('SELECT max(version) FROM schema_migrations').fetchone()[0]
        if not 12<=schema<=supported_schema() or manifest.get('schema_version',schema)!=schema:raise ValueError('Schema mismatch')
        if schema>=13:
            state=database.execute('SELECT server_instance_id,restore_epoch FROM rd_server_state WHERE id=1').fetchone()
            metadata=manifest.get('remote_desktop') or {}
            if state and (state[0]!=metadata.get('server_instance_id') or state[1]!=metadata.get('restore_epoch')):raise ValueError('RD metadata mismatch')
            if database.execute('SELECT count(*) FROM rd_endpoints').fetchone()[0] and 'config/deploy/secrets/rd_signing_key' not in names:raise ValueError('RD signing key missing')
        if database.execute("SELECT count(*) FROM users WHERE role='admin' AND deleted_at IS NULL").fetchone()[0]!=1:raise ValueError('Administrator singleton invalid')
    return manifest

def prepare_database(source,target):
    """Only mutate a fresh copy; keep the verified backup and its hashes intact."""
    if target.exists():raise ValueError('Prepared database must be a new file')
    with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as original, closing(sqlite3.connect(target)) as restored:
        original.backup(restored)
        has_rd=restored.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rd_server_state'").fetchone()
        if not has_rd:return
        restored.execute('PRAGMA foreign_keys=ON')
        restored.execute('BEGIN IMMEDIATE')
        restored.execute('UPDATE rd_server_state SET restore_epoch=restore_epoch+1 WHERE id=1')
        restored.execute("UPDATE rd_tokens SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        restored.execute("UPDATE rd_sessions SET state='closed',close_reason='RD_RESTORE_INVALIDATED',state_version=state_version+1,closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state NOT IN ('closed','failed','expired')")
        restored.execute('DELETE FROM rd_session_slots')
        restored.execute('DELETE FROM rd_challenges')
        restored.execute('DELETE FROM rd_idempotency')
        restored.execute("UPDATE rd_endpoints SET local_enabled=0")
        restored.execute("INSERT INTO rd_policy(scope_type,scope_id,policy_json,version,updated_at) VALUES('global','global','{\"enabled\":false}',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(scope_type,scope_id) DO UPDATE SET policy_json='{\"enabled\":false}',version=rd_policy.version+1,updated_at=excluded.updated_at")
        restored.commit()

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
    lines=[line for line in env.read_text(encoding='utf-8').splitlines() if not re.match(r'\s*(?:export\s+)?(?:COMPOSE_PROJECT_NAME|HOME_TUNNEL_RD_ENABLED|RD_ENABLED)\s*=',line)]
    env.write_text('\n'.join(lines)+f'\nCOMPOSE_PROJECT_NAME={args.project}\nHOME_TUNNEL_RD_ENABLED=false\nRD_ENABLED=false\n',encoding='utf-8')
    if os.name=='posix':
        (destination/'deploy/secrets').chmod(0o700)
        for file in (destination/'deploy/secrets').iterdir():file.chmod(0o644)
    subprocess.run(['docker','volume','create',volume],check=True,capture_output=True)
    # The target is a newly created Docker volume. No existing volume is erased.
    # Stream the verified file as the host owner, without a privileged host bind.
    # Set permissions before transferring ownership: CHOWN does not imply FOWNER.
    # Transfer the directory last so root can still traverse its owner-only mode.
    with tempfile.TemporaryDirectory(prefix='home-tunnel-restore-') as temporary:
      prepared=Path(temporary)/'database.sqlite3'
      prepare_database(bundle/'database.sqlite3',prepared)
      with prepared.open('rb') as source:
        subprocess.run(['docker','run','--rm','-i','--network','none','--cap-drop','ALL','--cap-add','CHOWN',
            '--mount',f'type=volume,source={volume},target=/target',
            'alpine:3.23','sh','-ec','test -z "$(ls -A /target)"; cat > /target/home-tunnel.db; chmod 700 /target; chmod 600 /target/home-tunnel.db; chown 10001:10001 /target/home-tunnel.db; chown 10001:10001 /target'],stdin=source,check=True)
    print('Restored into a new project. Inspect .env and DNS, then start from the destination with docker compose up -d. Login, device reconnection and public tunnel checks must follow.')

if __name__=='__main__':main()
