import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("encrypted repository roundtrip restores database, config and keys without its encryption password",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ht-disaster-recovery-"));
  const config=join(root,"config"), work=join(root,"work"), status=join(root,"status"), database=join(root,"home-tunnel.db");
  await mkdir(join(config,"deploy/secrets"),{recursive:true});
  await mkdir(join(config,"deploy/caddy"),{recursive:true});
  const password=randomBytes(32).toString("hex");
  await writeFile(join(root,"restic-password"),password);
  Object.assign(process.env,{NODE_ENV:"test",SQLITE_PATH:database,INTERNAL_SERVICE_KEY:"11".repeat(32),FRPS_PLUGIN_KEY:"22".repeat(32),LEASE_SIGNING_KEY:"33".repeat(32),BOOTSTRAP_ADMIN_PASSWORD:"Recovery-Test-Password-Q8",
    BACKUP_WORK_DIRECTORY:work,BACKUP_STATUS_DIRECTORY:status,BACKUP_CONFIG_ROOT:config,BACKUP_SOURCE_DATABASE:database,
    RESTIC_REPOSITORY:process.env.TEST_BACKUP_REPOSITORY || join(root,"encrypted-repository"),RESTIC_PASSWORD_FILE:join(root,"restic-password"),BACKUP_ALLOW_LOCAL_REPOSITORY:process.env.TEST_BACKUP_REPOSITORY ? "0" : "1"});
  const db=await import("../../control-center/dist/db.js");
  const runner=await import("./runner.mjs");
  try {
    await db.migrate();await db.bootstrapAdmin();
    await writeFile(join(config,".env"),`HOME_TUNNEL_VERSION=7.0.0\nRESTIC_PASSWORD=${password}\nHOME_TUNNEL_BACKUP_AWS_SECRET_ACCESS_KEY=not-in-bundle\n`);
    await writeFile(join(config,"compose.yaml"),"services: {}\n");
    await writeFile(join(config,"deploy/caddy/Caddyfile.selfhost"),"# recovery fixture\n");
    for(const name of ["internal_service_key","frps_plugin_key","lease_signing_key","bootstrap_admin_password","frps_tls_cert.pem","frps_tls_key.pem"])await writeFile(join(config,"deploy/secrets",name),`fixture-${name}`);
    await runner.main(["init"]);
    await runner.main(["backup"]);
    const result=JSON.parse(await readFile(join(status,"backup.json"),"utf8"));
    assert.equal(result.restore_verified,true);assert.equal(result.scope,process.env.TEST_BACKUP_REPOSITORY ? "offsite" : "local_repository");
    const restored=join(root,"restored");
    await runner.main(["restore",result.snapshot,"--target",restored]);
    const env=await readFile(join(restored,"config/.env"),"utf8");
    assert.ok(env.includes("HOME_TUNNEL_VERSION=7.0.0"));assert.ok(!env.includes(password));assert.ok(!env.includes("not-in-bundle"));
    assert.equal(await readFile(join(restored,"config/deploy/secrets/lease_signing_key"),"utf8"),"fixture-lease_signing_key");
    const manifest=await runner.verifyBundle(restored);assert.equal(manifest.version,"7.0.0");
    if (process.env.TEST_RESTORE_BUNDLE_PATH) await cp(restored,process.env.TEST_RESTORE_BUNDLE_PATH,{recursive:true,errorOnExist:true,force:false});
    await assert.rejects(runner.main(["restore",result.snapshot,"--target",restored]),/empty/);
    await writeFile(join(restored,"config/compose.yaml"),"tampered");
    await assert.rejects(runner.verifyBundle(restored),/checksum mismatch/);
    const edited=JSON.parse(await readFile(join(restored,"manifest.json"),"utf8"));
    edited.files[0].path="../escape";await writeFile(join(restored,"manifest.json"),JSON.stringify(edited));
    await assert.rejects(runner.verifyBundle(restored),/Unsafe/);
  }finally {await db.closeDatabase();await rm(root,{recursive:true,force:true});}
});
