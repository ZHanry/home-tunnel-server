import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildBundle, verifyBundle } from "./runner.mjs";

test("full bundle derives schema/version, requires a used RD key, and checks RD metadata",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ht-rd-bundle-"));
  try {
    const source=join(root,"source.sqlite3"),config=join(root,"config"),stage=join(root,"stage");
    await mkdir(join(config,"deploy/secrets"),{recursive:true});await mkdir(join(config,"deploy/caddy"),{recursive:true});await mkdir(stage);
    await writeFile(join(config,".env"),"HOME_TUNNEL_VERSION=8.0.0\nHOME_TUNNEL_RD_ENABLED=false\n");
    await writeFile(join(config,"compose.yaml"),"services: {}\n");await writeFile(join(config,"deploy/caddy/Caddyfile.selfhost"),"# fixture\n");
    for(const name of ["internal_service_key","frps_plugin_key","lease_signing_key","bootstrap_admin_password","frps_tls_cert.pem","frps_tls_key.pem"])await writeFile(join(config,"deploy/secrets",name),"isolated fixture");
    const database=new DatabaseSync(source);
    const user=randomUUID();
    try {
      database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT 'fixture') STRICT");
      const migrations=new URL("../../control-center/migrations/",import.meta.url);
      for(const file of (await readdir(migrations)).filter(name=>/^\d+_.*\.sql$/.test(name)).sort()){
        database.exec(await readFile(new URL(file,migrations),"utf8"));
        database.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(Number(file.split("_")[0]));
      }
      database.prepare("INSERT INTO users(id,username,display_name,password_hash,password_state,role) VALUES(?,'admin','Fixture','fixture','normal','admin')").run(user);
      database.prepare("INSERT INTO rd_server_state(id,server_instance_id,restore_epoch) VALUES(1,?,4)").run(randomUUID());
      database.prepare("INSERT INTO rd_endpoints(id,owner_user_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at) VALUES(?,?,'browser','controller','Fixture','browser','{}',?,'2026-09-22','2026-09-22')").run(randomUUID(),user,randomUUID());
    } finally {database.close();}
    await assert.rejects(buildBundle(stage,source,config),/signing key is missing/);
    const next=join(root,"next");await mkdir(next);
    await writeFile(join(config,"deploy/secrets/rd_signing_key"),"isolated fixture key");
    const bundle=await buildBundle(next,source,config),manifest=await verifyBundle(bundle);
    const packageMetadata=JSON.parse(await readFile(new URL("../../control-center/package.json",import.meta.url),"utf8"));
    const maxSchema=Math.max(...(await readdir(new URL("../../control-center/migrations/",import.meta.url))).filter(name=>/^\d+_.*\.sql$/.test(name)).map(name=>Number(name.split("_")[0])));
    assert.equal(manifest.version,packageMetadata.version);assert.equal(manifest.schema_version,maxSchema);assert.equal(manifest.remote_desktop.restore_epoch,4);
    manifest.remote_desktop.restore_epoch=3;await writeFile(join(bundle,"manifest.json"),JSON.stringify(manifest));
    await assert.rejects(verifyBundle(bundle),/metadata/);
  } finally {await rm(root,{recursive:true,force:true});}
});
