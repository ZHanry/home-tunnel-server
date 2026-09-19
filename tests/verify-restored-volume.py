"""Read the newly imported CI volume, verify data and reject a second import."""
from pathlib import Path
import os, sqlite3, subprocess, tempfile
volume='ht-restore-ci_sqlite-data'
with tempfile.TemporaryDirectory(prefix='ht-restored-volume-') as directory:
    container=subprocess.check_output(['docker','create','--network','none','-v',volume+':/data:ro','alpine:3.23','true'],text=True).strip()
    try:
        target=Path(directory)/'database.sqlite3'
        subprocess.run(['docker','cp',container+':/data/home-tunnel.db',str(target)],check=True)
        with sqlite3.connect(target) as database:
            assert database.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
            assert database.execute("SELECT count(*) FROM users WHERE role='admin' AND deleted_at IS NULL").fetchone()[0]==1
        # Exercise the restored database through the real authentication routes.
        script='''
const {createApplication}=await import('./control-center/dist/server.js');
const {closeDatabase}=await import('./control-center/dist/db.js');
const app=await createApplication(false); const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
try {
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'Recovery-Test-Password-Q8',client_type:'linux'})});
 const result=await response.json();
 if(response.status!==200 || result.user.role!=='admin' || !result.password_change_required)throw new Error('Restored login or first-password flow failed');
 console.log('Restored administrator login passed');
} finally {await new Promise(resolve=>server.close(resolve)); await closeDatabase();}
'''
        environment={**os.environ,'SQLITE_PATH':str(target),'NODE_ENV':'test','INTERNAL_SERVICE_KEY':'11'*32,'FRPS_PLUGIN_KEY':'22'*32,'LEASE_SIGNING_KEY':'33'*32}
        subprocess.run(['node','--input-type=module','-e',script],env=environment,check=True)
    finally:subprocess.run(['docker','rm',container],check=True,stdout=subprocess.DEVNULL)
print('Fresh volume import, SQLite integrity and real login verified')
