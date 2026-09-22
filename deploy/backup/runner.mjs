import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const packageMetadata = JSON.parse(await readFile(new URL("../../control-center/package.json", import.meta.url), "utf8").catch(() => readFile(new URL("./package.json", import.meta.url), "utf8")));
const releaseVersion = packageMetadata.version;
const migrationNames = await readdir(new URL("../../control-center/migrations/", import.meta.url)).catch(() => readdir(new URL("./migrations/", import.meta.url)));
const supportedSchema = Math.max(...migrationNames.filter(name => /^\d+_.*\.sql$/.test(name)).map(name => Number(name.split("_")[0])));
const secretFiles = ["internal_service_key","frps_plugin_key","lease_signing_key","bootstrap_admin_password","frps_tls_cert.pem","frps_tls_key.pem"];
const optionalOperationsFiles = ["compose.release.yaml", "deploy/compose.backup.yaml", "deploy/compose.monitoring.yaml", "deploy/backup/Dockerfile", "deploy/backup/runner.mjs", "deploy/monitoring/prometheus.generated.yml", "deploy/monitoring/prometheus.yml.template", "deploy/monitoring/alerts.yml", "deploy/monitoring/alertmanager.yml", "deploy/monitoring/blackbox.yml", "deploy/monitoring/dashboards/home-tunnel.json", "deploy/monitoring/provisioning/dashboards/default.yml", "deploy/monitoring/provisioning/datasources/default.yml", "deploy/secrets/grafana_admin_password"];
const rdFiles = ["deploy/secrets/rd_signing_key", "deploy/rd-keyset.json", "deploy/compose.rd-keyset.yaml", "deploy/scripts/rotate-rd-key.mjs", "deploy/compose.rd.yaml", "deploy/compose.stun.yaml", "deploy/stun/turnserver.conf", "deploy/stun/firewall.nft", "deploy/scripts/stun-firewall.sh", "deploy/scripts/probe-stun.py", "docs/REMOTE_DESKTOP_OPERATIONS.md"];
const configFiles = [...optionalOperationsFiles,...rdFiles,"compatibility.json","control-center/package.json",...migrationNames.filter(name => /^\d+_.*\.sql$/.test(name)).map(name=>`control-center/migrations/${name}`),".env","compose.yaml","compose.override.yaml","deploy/compose.ports.yaml","deploy/compose.tcp.yaml","deploy/compose.udp.yaml","deploy/compose.l4.yaml","deploy/caddy/Caddyfile.selfhost",...secretFiles.map(name=>`deploy/secrets/${name}`)];
const requiredConfig = [".env","compose.yaml","deploy/caddy/Caddyfile.selfhost",...secretFiles.map(name=>`deploy/secrets/${name}`)];
const allowedPaths = new Set(["database.sqlite3",...configFiles.map(name=>`config/${name}`)]);
const host = process.env.BACKUP_HOST || "home-tunnel";
const workRoot = resolve(process.env.BACKUP_WORK_DIRECTORY || "/work");
const statusRoot = resolve(process.env.BACKUP_STATUS_DIRECTORY || "/status");

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function contained(root,path) {
  const rel = relative(root,path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function safeFile(root,path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !contained(await realpath(root),await realpath(path))) throw new Error("Bundle files must be regular files inside their root");
  return info;
}

async function writeStatus(name,data) {
  await mkdir(statusRoot,{recursive:true,mode:0o755});
  let previous={};
  try { previous=JSON.parse(await readFile(join(statusRoot,`${name}.json`),"utf8")); } catch {}
  data={...data,last_success_at:data.status==="healthy"?(data.completed_at??data.verified_at):previous.last_success_at??null,
    scope:data.scope??previous.scope??"unknown"};
  const temporary = join(statusRoot,`.${name}-${randomUUID()}.tmp`);
  await writeFile(temporary,`${JSON.stringify(data)}\n`,{mode:0o644,flag:"wx"});
  await rename(temporary,join(statusRoot,`${name}.json`));
}

function restic(args,cwd=workRoot) {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(process.env.RESTIC_BINARY || "restic",args,{cwd,env:{...process.env,RESTIC_CACHE_DIR:join(workRoot,"cache")},stdio:["ignore","pipe","pipe"]});
    let output="", bytes=0;
    child.stdout.on("data",chunk=>{bytes+=chunk.length;if (bytes>8*1024*1024) child.kill();else output+=chunk;});
    // Backend errors can contain repository credentials; callers get an exit code.
    child.stderr.resume();
    const timer=setTimeout(()=>child.kill(),30*60_000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("exit",code=>{clearTimeout(timer);if(code===0)resolvePromise(output);else reject(new Error(`restic ${args[0]} failed (exit ${code}); inspect backend access with restic directly`));});
  });
}

export async function buildBundle(stage,source,configRoot) {
  const bundle=join(stage,"bundle");await mkdir(bundle,{recursive:true,mode:0o700});
  await safeFile(dirname(source),source);
  const sourceDb=new DatabaseSync(source,{readOnly:true});
  try { await backup(sourceDb,join(bundle,"database.sqlite3"),{rate:256}); }
  finally {sourceDb.close();}
  const portable = new DatabaseSync(join(bundle,"database.sqlite3"));
  let schema,rdState=null,rdUsed=false;
  try {
    portable.exec("PRAGMA journal_mode=DELETE");
    schema=Number(portable.prepare("SELECT max(version) AS version FROM schema_migrations").get().version);
    if(schema>=13) {
      rdState=portable.prepare("SELECT server_instance_id,restore_epoch,keyset_version FROM rd_server_state WHERE id=1").get() ?? null;
      rdUsed=Number(portable.prepare("SELECT count(*) AS count FROM rd_endpoints").get().count)>0;
    }
  } finally { portable.close(); }
  const files=[];
  for (const name of configFiles) {
    const from=join(configRoot,name), to=join(bundle,"config",name);
    try {await safeFile(configRoot,from);}
    catch(error) {if (error.code==="ENOENT" && !requiredConfig.includes(name))continue;throw error;}
    await mkdir(dirname(to),{recursive:true,mode:0o700});
    if (name===".env") {
      const lines=(await readFile(from,"utf8")).split(/\r?\n/).filter(line=>!/^\s*(?:export\s+)?(?:RESTIC_|AWS_|AZURE_|B2_|RCLONE_|HOME_TUNNEL_BACKUP_)[A-Z0-9_]*\s*=/.test(line));
      await writeFile(to,`${lines.join("\n")}\n`,{mode:0o600,flag:"wx"});
    } else await cp(from,to,{force:false,errorOnExist:true});
    files.push(`config/${name}`);
  }
  files.push("database.sqlite3");
  const hasRdKey=files.includes("config/deploy/secrets/rd_signing_key");
  if(rdUsed && !hasRdKey)throw new Error("RD has registered identities but its signing key is missing from the protected deployment directory");
  const manifest={format:1,version:releaseVersion,schema_version:schema,remote_desktop:rdState?{...rdState,signing_key_included:hasRdKey}:null,created_at:new Date().toISOString(),files:[]};
  for (const path of files.sort()) manifest.files.push({path,size:(await stat(join(bundle,path))).size,sha256:await digest(join(bundle,path))});
  await writeFile(join(bundle,"manifest.json"),JSON.stringify(manifest),{mode:0o600,flag:"wx"});
  await verifyBundle(bundle);
  return bundle;
}

export async function verifyBundle(bundle) {
  await safeFile(bundle,join(bundle,"manifest.json"));
  const manifest=JSON.parse(await readFile(join(bundle,"manifest.json"),"utf8"));
  if (manifest.format!==1 || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(manifest.version) || !Array.isArray(manifest.files) || manifest.files.length>128) throw new Error("Unsupported backup manifest");
  const paths=new Set();
  for (const item of manifest.files) {
    if (!allowedPaths.has(item.path) || paths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Unsafe or duplicate backup path");
    paths.add(item.path);
    const path=join(bundle,item.path),info=await safeFile(bundle,path);
    if (info.size!==item.size || await digest(path)!==item.sha256)throw new Error(`Backup checksum mismatch: ${item.path}`);
  }
  for (const path of ["database.sqlite3",...requiredConfig.map(name=>`config/${name}`)]) if (!paths.has(path)) throw new Error(`Backup is incomplete: ${path}`);
  async function inspect(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink()) throw new Error("Backup contains a symbolic link");
      if(entry.isDirectory())await inspect(path);
      else if(relative(bundle,path).replaceAll("\\","/")!=="manifest.json" && !paths.has(relative(bundle,path).replaceAll("\\","/")))throw new Error("Backup contains an unlisted file");
    }
  }
  await inspect(bundle);
  const database=new DatabaseSync(join(bundle,"database.sqlite3"),{readOnly:true});
  try {
    if(database.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")throw new Error("Restored SQLite integrity check failed");
    if(database.prepare("PRAGMA foreign_key_check").all().length)throw new Error("Restored database foreign keys are invalid");
    const schema=Number(database.prepare("SELECT max(version) AS version FROM schema_migrations").get().version);
    if(schema<12 || schema>supportedSchema || (manifest.schema_version!==undefined && manifest.schema_version!==schema))throw new Error("Restore requires a supported schema and matching manifest");
    if(schema>=13) {
      const state=database.prepare("SELECT server_instance_id,restore_epoch,keyset_version FROM rd_server_state WHERE id=1").get() ?? null;
      if(state && (!manifest.remote_desktop || state.server_instance_id!==manifest.remote_desktop.server_instance_id || state.restore_epoch!==manifest.remote_desktop.restore_epoch))throw new Error("RD instance metadata does not match the backup manifest");
      if(Number(database.prepare("SELECT count(*) AS count FROM rd_endpoints").get().count)>0 && !paths.has("config/deploy/secrets/rd_signing_key"))throw new Error("RD signing key is missing from the protected backup");
    }
    if(Number(database.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND deleted_at IS NULL").get().count)!==1)throw new Error("Restored database must have one administrator");
  } finally {database.close();}
  return manifest;
}

async function restoreVerified(stage,snapshot="latest") {
  if(snapshot!=="latest" && !/^[a-f0-9]{8,64}$/.test(snapshot))throw new Error("Invalid snapshot identifier");
  const target=join(stage,"restored");
  await restic(["restore",snapshot,"--tag","home-tunnel-full","--host",host,"--target",target,"--verify"]);
  const bundle=join(target,"bundle");
  const manifest=await verifyBundle(bundle);
  await writeStatus("restore",{status:"healthy",verified_at:new Date().toISOString(),snapshot,version:manifest.version,verification:"restic-full-restore+manifest-sha256+sqlite-integrity+foreign-keys"});
  return {bundle,manifest};
}

export async function main(args=process.argv.slice(2)) {
  process.umask(0o077);
  if (!process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE) throw new Error("RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE are required; keep the password outside this deployment and backup");
  const remote=/^(s3:https:\/\/|sftp:|rest:https:\/\/|azure:|gs:|b2:|rclone:)/.test(process.env.RESTIC_REPOSITORY);
  if (!remote && process.env.BACKUP_ALLOW_LOCAL_REPOSITORY!=="1")throw new Error("An off-host encrypted repository is required (HTTPS S3/REST, SFTP or a supported cloud backend)");
  await mkdir(workRoot,{recursive:true,mode:0o700});
  if(args[0]==="init") {await restic(["init"]);console.log("Encrypted backup repository initialized");return;}
  if(!["backup","verify","restore"].includes(args[0]))throw new Error("Usage: runner.mjs init | backup | verify [snapshot] | restore [snapshot] --target EMPTY_DIRECTORY");
  const stage=await mkdtemp(join(workRoot,"home-tunnel-"));
  try {
    if(args[0]==="backup") {
      await buildBundle(stage,resolve(process.env.BACKUP_SOURCE_DATABASE || "/source/data/home-tunnel.db"),resolve(process.env.BACKUP_CONFIG_ROOT || "/source/config"));
      const output=await restic(["backup","bundle","--tag","home-tunnel-full","--host",host,"--json"],stage);
      const summary=output.trim().split("\n").map(line=>JSON.parse(line)).find(item=>item.message_type==="summary");
      if(!/^[a-f0-9]{8,64}$/.test(summary?.snapshot_id || ""))throw new Error("Backup did not return a snapshot id");
      await restic(["check"]);
      await restoreVerified(stage,summary.snapshot_id);
      await writeStatus("backup",{status:"healthy",scope:remote?"offsite":"local_repository",completed_at:new Date().toISOString(),snapshot:summary.snapshot_id,size_bytes:summary.total_bytes_processed,sha256:await digest(join(stage,"bundle","manifest.json")),restore_verified:true});
      console.log(JSON.stringify({status:"healthy",snapshot:summary.snapshot_id,restore_verified:true,scope:remote?"offsite":"local_repository"}));
    } else {
      const snapshot=args[1] && !args[1].startsWith("--")?args[1]:"latest";
      const result=await restoreVerified(stage,snapshot);
      if(args[0]==="restore") {
        const index=args.indexOf("--target"), rawTarget=index>=0?args[index+1]:null;
        if(!rawTarget || !isAbsolute(rawTarget))throw new Error("Restore requires an absolute --target path to an empty directory");
        const target=resolve(rawTarget);
        if(target===dirname(target))throw new Error("Cannot restore to a filesystem root");
        await mkdir(target,{recursive:true,mode:0o700});
        if((await lstat(target)).isSymbolicLink() || (await readdir(target)).length)throw new Error("Restore target must be an empty, real directory; existing deployments are never replaced");
        for (const name of await readdir(result.bundle)) await cp(join(result.bundle,name),join(target,name),{recursive:true,force:false,errorOnExist:true});
        await verifyBundle(target);
        console.log("Verified deployment bundle restored. Follow docs/disaster-recovery.md to import the database into a fresh volume.");
      } else console.log("Full encrypted restore, manifest checksums and SQLite integrity verified");
    }
  } catch(error) {
    await writeStatus(args[0]==="backup"?"backup":"restore",{status:"failed",failed_at:new Date().toISOString(),error_code:"BACKUP_OR_RESTORE_FAILED"});
    throw error;
  } finally {
    // stage is a freshly created directory under the dedicated work root.
    if(!contained(workRoot,stage))throw new Error("Unsafe temporary directory");
    await rm(stage,{recursive:true,force:true});
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
