import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort();

function apply(database: DatabaseSync, names: string[]): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ) STRICT;`);
  for (const name of names) {
    const version = Number(name.slice(0, 3));
    const foreignKeysEnabled =
      Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
    if (version === 18) database.exec("PRAGMA foreign_keys=OFF");
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      database.exec(readFileSync(new URL(name, migrationsDirectory), "utf8"));
      if (version === 18 && foreignKeysEnabled)
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const hasChecksum = database
        .prepare("PRAGMA table_info(schema_migrations)")
        .all()
        .some((column) => String(column.name) === "checksum_sha256");
      if (hasChecksum) {
        database.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(version);
      } else {
        database.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(version);
      }
      database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) database.exec("ROLLBACK");
      throw error;
    } finally {
      if (version === 18 && foreignKeysEnabled) database.exec("PRAGMA foreign_keys=ON");
    }
  }
}

test("legacy administrators consolidate without deleting accounts, devices or history", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    const index = migrations.findIndex((name) => name.startsWith("010_"));
    apply(database, migrations.slice(0, index));
    database.exec(`INSERT INTO users(id,username,display_name,password_hash,password_state,role,created_at)
      VALUES('first','first','First','hash','normal','admin','2024-01-01'),
      ('second','second','Second','hash','normal','admin','2025-01-01');
      INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash)
      VALUES('device','second','Old device','install','fingerprint','credential');`);
    apply(database, migrations.slice(index));
    assert.equal(database.prepare("SELECT role FROM users WHERE id='first'").get()?.role, "admin");
    assert.equal(database.prepare("SELECT role FROM users WHERE id='second'").get()?.role, "user");
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM devices WHERE user_id='second'").get()?.count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='AdministratorConsolidated'",
        )
        .get()?.count,
      1,
    );
    assert.throws(() => database.exec("UPDATE users SET role='admin' WHERE id='second'"), /UNIQUE/);
  } finally {
    database.close();
  }
});

test("the earliest public database upgrades additively through every migration", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    apply(database, [migrations[0]!]);
    database
      .prepare(
        `INSERT INTO users(id,username,display_name,password_hash,password_state,role)
       VALUES('user-1','alice','Alice','hash','normal','user')`,
      )
      .run();
    apply(database, migrations.slice(1));
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => Number(row.version)),
      migrations.map((name) => Number(name.slice(0, 3))),
    );
    const user = database
      .prepare("SELECT username,quota_suspended_at FROM users WHERE id='user-1'")
      .get();
    assert.equal(user?.username, "alice");
    assert.equal(user?.quota_suspended_at, null);
    const columns = database
      .prepare("PRAGMA table_info(connections)")
      .all()
      .map((row) => String(row.name));
    for (const column of [
      "access_policy_version",
      "proxy_type",
      "tcp_remote_port",
      "transport_type",
      "remote_port",
    ])
      assert.ok(columns.includes(column));
    assert.ok(
      database
        .prepare("PRAGMA table_info(schema_migrations)")
        .all()
        .some((row) => String(row.name) === "checksum_sha256"),
    );
  } finally {
    database.close();
  }
});

test("assist invitation migration preserves endpoints and revokes codes with their host", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    const index = migrations.findIndex((name) => name.startsWith("017_"));
    assert.ok(index > 0);
    apply(database, migrations.slice(0, index));
    database.exec(`INSERT INTO users(id,username,display_name,password_hash,password_state,role)
      VALUES('owner','owner','Owner','hash','normal','user');
      INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash)
      VALUES('device','owner','Host','install','fingerprint','credential');
      INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at)
      VALUES('host','owner','device','desktop','host','Host','windows','{}','thumbprint','2026-01-01','2026-01-01');`);
    apply(database, migrations.slice(index));
    database.exec("UPDATE rd_endpoints SET local_enabled=1 WHERE id='host'");
    database.exec(`INSERT INTO rd_assist_invites(id,device_code,host_owner_user_id,host_endpoint_id,password_salt,password_hash,expires_at,created_at)
      VALUES('invite','123456789','owner','host','salt','hash','2027-01-01','2026-01-01');`);
    assert.equal(
      database.prepare("SELECT name FROM rd_endpoints WHERE id='host'").get()?.name,
      "Host",
    );
    database.exec("UPDATE rd_endpoints SET local_enabled=0 WHERE id='host'");
    assert.equal(
      database.prepare("SELECT state FROM rd_assist_invites WHERE id='invite'").get()?.state,
      "revoked",
    );
    database.exec(`INSERT INTO rd_assist_invites(id,device_code,host_owner_user_id,host_endpoint_id,password_salt,password_hash,expires_at,created_at)
      VALUES('invite2','123456789','owner','host','salt','hash','2027-01-01','2026-01-01');`);
    database.exec("UPDATE rd_endpoints SET status='revoked' WHERE id='host'");
    assert.equal(
      database.prepare("SELECT state FROM rd_assist_invites WHERE id='invite2'").get()?.state,
      "revoked",
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("cross-account migration preserves live legacy sessions and their foreign keys", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    const index = migrations.findIndex((name) => name.startsWith("018_"));
    assert.ok(index > 0);
    apply(database, migrations.slice(0, index));
    database.exec(`
      INSERT INTO users(id,username,display_name,password_hash,password_state,role)
      VALUES('owner','owner','Owner','hash','normal','user');
      INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash)
      VALUES('device','owner','Host','install','fingerprint','credential');
      INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,local_enabled,created_at,updated_at)
      VALUES('host','owner','device','desktop','host','Host','windows','{}','host-jkt',1,'2026-01-01','2026-01-01');
      INSERT INTO rd_endpoints(id,owner_user_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at)
      VALUES('controller','owner','browser','controller','Browser','browser','{}','controller-jkt','2026-01-01','2026-01-01');
      INSERT INTO rd_pairings(id,owner_user_id,host_endpoint_id,controller_endpoint_id,session_request_id,requested_scope_json,transcript_json,state,expires_at,created_at)
      VALUES('pair','owner','host','controller','request','["view"]','{}','confirmed','2030-01-01','2026-01-01');
      INSERT INTO rd_grants(id,owner_user_id,host_endpoint_id,controller_endpoint_id,host_jkt,controller_jkt,scope_json,mode,one_session_request_id,grant_version,host_signature,created_at,updated_at)
      VALUES('pair','owner','host','controller','host-jkt','controller-jkt','["view"]','one_session','request',1,'signed','2026-01-01','2026-01-01');
      INSERT INTO rd_sessions(id,owner_user_id,host_endpoint_id,controller_endpoint_id,user_token_version,grant_id,grant_version,permissions_json,display_id,state,restore_epoch,approval_expires_at,created_at,updated_at,session_request_id)
      VALUES('session','owner','host','controller',1,'pair',1,'["view"]','main','authorized',1,'2030-01-01','2026-01-01','2026-01-01','request');
      INSERT INTO rd_session_slots(endpoint_id,session_id,role,hold_until)
      VALUES('host','session','host','2030-01-01'),('controller','session','controller','2030-01-01');
    `);
    apply(database, migrations.slice(index));
    assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT owner_user_id,controller_owner_user_id,assist_invite_id FROM rd_sessions WHERE id='session'",
          )
          .get(),
      },
      { owner_user_id: "owner", controller_owner_user_id: "owner", assist_invite_id: null },
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM rd_session_slots WHERE session_id='session'")
        .get()?.count,
      2,
    );
    database.exec("UPDATE rd_endpoints SET status='revoked' WHERE id='host'");
    assert.equal(
      database.prepare("SELECT state FROM rd_sessions WHERE id='session'").get()?.state,
      "closing",
    );
  } finally {
    database.close();
  }
});

test("access mode migration preserves old invitations and revokes fixed access on account rotation", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    const index = migrations.findIndex((name) => name.startsWith("019_"));
    assert.ok(index > 0);
    apply(database, migrations.slice(0, index));
    database.exec(`
      INSERT INTO users(id,username,display_name,password_hash,password_state,role)
      VALUES('owner','owner','Owner','hash','normal','user'),('visitor','visitor','Visitor','hash','normal','user');
      INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash)
      VALUES('device','owner','Host','install','fingerprint','credential');
      INSERT INTO rd_endpoints(id,owner_user_id,linked_device_id,kind,role,name,platform,public_jwk,jkt,local_enabled,created_at,updated_at)
      VALUES('host','owner','device','desktop','host','Host','windows','{}','host-jkt',1,'2026-01-01','2026-01-01');
      INSERT INTO rd_endpoints(id,owner_user_id,kind,role,name,platform,public_jwk,jkt,created_at,updated_at)
      VALUES('controller','visitor','browser','controller','Visitor','browser','{}','visitor-jkt','2026-01-01','2026-01-01');
      INSERT INTO rd_assist_invites(id,device_code,host_owner_user_id,host_endpoint_id,password_salt,password_hash,expires_at,created_at)
      VALUES('legacy-invite','123456789','owner','host','salt','hash','2030-01-01','2026-01-01');
    `);
    apply(database, migrations.slice(index));
    assert.equal(
      database.prepare("SELECT access_kind FROM rd_assist_invites WHERE id='legacy-invite'").get()
        ?.access_kind,
      "temporary_password",
    );
    database.exec(`
      INSERT INTO rd_access_profiles(host_endpoint_id,host_owner_user_id,device_code,password_hash,created_at,updated_at)
      VALUES('host','owner','987654321','argon2-hash','2026-01-01','2026-01-01');
      INSERT INTO rd_access_requests(id,host_endpoint_id,host_owner_user_id,controller_endpoint_id,controller_owner_user_id,expires_at,created_at)
      VALUES('request','host','owner','controller','visitor','2030-01-01','2026-01-01');
      INSERT INTO rd_assist_invites(id,device_code,host_owner_user_id,host_endpoint_id,password_salt,password_hash,state,expires_at,created_at,redeemed_by_user_id,redeemed_by_endpoint_id,access_kind,profile_revision)
      VALUES('fixed-invite','987654321','owner','host','','','redeemed','2030-01-01','2026-01-01','visitor','controller','fixed_password',1);
      UPDATE users SET token_version=token_version+1 WHERE id='owner';
    `);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT password_hash,revision FROM rd_access_profiles WHERE host_endpoint_id='host'",
          )
          .get(),
      },
      { password_hash: null, revision: 2 },
    );
    assert.equal(
      database.prepare("SELECT state FROM rd_access_requests WHERE id='request'").get()?.state,
      "rejected",
    );
    assert.equal(
      database.prepare("SELECT state FROM rd_assist_invites WHERE id='fixed-invite'").get()?.state,
      "revoked",
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("the L4 migration copies legacy TCP and mirrors canonical TCP/UDP fields", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    const l4Index = migrations.findIndex((name) => name.startsWith("008_"));
    assert.ok(l4Index > 0, "008 L4 migration is present");
    apply(database, migrations.slice(0, l4Index));
    database.exec(`
      INSERT INTO users(id,username,display_name,password_hash,password_state,role)
      VALUES('user-l4','l4-user','L4 User','hash','normal','user');
      INSERT INTO devices(id,user_id,name,install_id,fingerprint_hash,credential_hash)
      VALUES('device-l4','user-l4','L4 Device','install-l4','fingerprint-l4','credential-l4');
      INSERT INTO connections(
        id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port,
        proxy_type,tcp_remote_port)
      VALUES(
        'connection-tcp','user-l4','device-l4','Legacy TCP','legacy-tcp','http','127.0.0.1',22,
        'tcp',10001);
    `);

    apply(database, migrations.slice(l4Index));
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
             FROM connections WHERE id='connection-tcp'`,
          )
          .get(),
      },
      {
        transport_type: "tcp",
        remote_port: 10001,
        proxy_type: "tcp",
        tcp_remote_port: 10001,
      },
    );

    // 模拟数据库已升级但 v3.0 进程仍在运行：INSERT 完全不提新列。
    database
      .prepare(
        `INSERT INTO connections(
           id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port,
           proxy_type,tcp_remote_port)
         VALUES('connection-old-writer','user-l4','device-l4','Old writer TCP','old-writer-tcp',
                'http','127.0.0.1',22,'tcp',10002)`,
      )
      .run();
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
               FROM connections WHERE id='connection-old-writer'`,
          )
          .get(),
      },
      {
        transport_type: "tcp",
        remote_port: 10002,
        proxy_type: "tcp",
        tcp_remote_port: 10002,
      },
    );

    // 旧 writer 只更新 legacy 端口时，canonical 端口同步前进。
    database
      .prepare(
        `UPDATE connections SET tcp_remote_port=10003
          WHERE id='connection-old-writer'`,
      )
      .run();
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
               FROM connections WHERE id='connection-old-writer'`,
          )
          .get(),
      },
      {
        transport_type: "tcp",
        remote_port: 10003,
        proxy_type: "tcp",
        tcp_remote_port: 10003,
      },
    );

    // 旧 writer 把 TCP 改回 HTTP 时，新列与残留端口也必须同步清理。
    database
      .prepare(
        `UPDATE connections SET proxy_type='http',tcp_remote_port=NULL
          WHERE id='connection-old-writer'`,
      )
      .run();
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
               FROM connections WHERE id='connection-old-writer'`,
          )
          .get(),
      },
      {
        transport_type: "http",
        remote_port: null,
        proxy_type: "http",
        tcp_remote_port: null,
      },
    );

    assert.throws(() =>
      database
        .prepare(
          `UPDATE connections SET proxy_type='tcp',tcp_remote_port=10001
            WHERE id='connection-old-writer'`,
        )
        .run(),
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
               FROM connections WHERE id='connection-old-writer'`,
          )
          .get(),
      },
      {
        transport_type: "http",
        remote_port: null,
        proxy_type: "http",
        tcp_remote_port: null,
      },
    );

    // 唯一约束必须在旧 INSERT 被 canonicalize 后生效，并原子回滚整次写入。
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO connections(
             id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port,
             proxy_type,tcp_remote_port)
           VALUES('connection-old-conflict','user-l4','device-l4','Old writer conflict',
                  'old-writer-conflict','http','127.0.0.1',22,'tcp',10001)`,
        )
        .run(),
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM connections WHERE id='connection-old-conflict'")
        .get()?.count,
      0,
    );

    database
      .prepare(
        `INSERT INTO connections(
           id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port,
           transport_type,remote_port,proxy_type,tcp_remote_port)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "connection-udp",
        "user-l4",
        "device-l4",
        "UDP",
        "udp",
        "http",
        "127.0.0.1",
        53,
        "udp",
        10001,
        "http",
        10002,
      );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
             FROM connections WHERE id='connection-udp'`,
          )
          .get(),
      },
      {
        transport_type: "udp",
        remote_port: 10001,
        proxy_type: "tcp",
        tcp_remote_port: null,
      },
    );
    assert.throws(() =>
      database
        .prepare(
          `UPDATE connections SET proxy_type='tcp',tcp_remote_port=10002
            WHERE id='connection-udp'`,
        )
        .run(),
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT transport_type,remote_port,proxy_type,tcp_remote_port
               FROM connections WHERE id='connection-udp'`,
          )
          .get(),
      },
      {
        transport_type: "udp",
        remote_port: 10001,
        proxy_type: "tcp",
        tcp_remote_port: null,
      },
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO connections(
             id,user_id,device_id,name,subdomain,local_scheme,local_host,local_port,
             transport_type,remote_port,proxy_type)
           VALUES('connection-udp-duplicate','user-l4','device-l4','UDP duplicate','udp-duplicate',
                  'http','127.0.0.1',53,'udp',10001,'tcp')`,
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          `UPDATE connections SET transport_type='http',remote_port=10002
            WHERE id='connection-udp'`,
        )
        .run(),
    );
  } finally {
    database.close();
  }
});

test("RD reconnect migration preserves prior recovery attempts independently of display epochs", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  try {
    const index = migrations.findIndex((name) => name.startsWith("016_"));
    assert.ok(index > 0);
    apply(database, migrations.slice(0, index));
    const insert = database.prepare(
      `INSERT INTO rd_sessions(id,owner_user_id,host_endpoint_id,controller_endpoint_id,
        user_token_version,grant_id,grant_version,permissions_json,display_id,state,
        connection_epoch,restore_epoch,approval_expires_at,created_at,updated_at)
        VALUES(?,'owner','host','controller',1,'grant',1,'["view"]','display-1','active',?,1,
        '2030-01-01','2026-01-01','2026-01-01')`,
    );
    for (const epoch of [1, 2, 4]) insert.run(`session-${epoch}`, epoch);
    apply(database, migrations.slice(index));
    assert.deepEqual(
      database
        .prepare("SELECT network_reconnect_count FROM rd_sessions ORDER BY connection_epoch")
        .all()
        .map((row) => row.network_reconnect_count),
      [0, 1, 3],
    );
    database.exec("UPDATE rd_sessions SET connection_epoch=99 WHERE id='session-1'");
    assert.equal(
      database.prepare("SELECT network_reconnect_count FROM rd_sessions WHERE id='session-1'").get()
        ?.network_reconnect_count,
      0,
    );
    assert.throws(() => database.exec("UPDATE rd_sessions SET network_reconnect_count=4"), /CHECK/);
    assert.throws(
      () => database.exec("UPDATE rd_sessions SET network_reconnect_count=-1"),
      /CHECK/,
    );
  } finally {
    database.close();
  }
});

test("a file backup restores data and can continue to accept writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "home-tunnel-restore-test-"));
  const sourcePath = join(directory, "source.sqlite3");
  const backupPath = join(directory, "backup.sqlite3");
  const restoredPath = join(directory, "restored.sqlite3");
  try {
    const source = new DatabaseSync(sourcePath, { enableForeignKeyConstraints: true });
    apply(source, migrations);
    source
      .prepare(
        `INSERT INTO users(id,username,display_name,password_hash,password_state,role)
       VALUES('user-restore','restored','Restored User','hash','normal','user')`,
      )
      .run();
    source.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    source.close();
    copyFileSync(backupPath, restoredPath);
    const restored = new DatabaseSync(restoredPath, { enableForeignKeyConstraints: true });
    try {
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(
        restored.prepare("SELECT username FROM users WHERE id='user-restore'").get()?.username,
        "restored",
      );
      restored.prepare("UPDATE users SET display_name='Recovered' WHERE id='user-restore'").run();
      assert.equal(
        restored.prepare("SELECT display_name FROM users WHERE id='user-restore'").get()
          ?.display_name,
        "Recovered",
      );
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed migration rolls back its schema and migration journal atomically", () => {
  const database = new DatabaseSync(":memory:");
  try {
    apply(database, [migrations[0]!]);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("CREATE TABLE migration_should_rollback(id INTEGER PRIMARY KEY) STRICT;");
      database.exec("THIS IS NOT VALID SQL");
      database.prepare("INSERT INTO schema_migrations(version) VALUES(999)").run();
      database.exec("COMMIT");
      assert.fail("invalid migration unexpectedly committed");
    } catch {
      database.exec("ROLLBACK");
    }
    assert.equal(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name='migration_should_rollback'")
        .get(),
      undefined,
    );
    assert.equal(
      database.prepare("SELECT version FROM schema_migrations WHERE version=999").get(),
      undefined,
    );
  } finally {
    database.close();
  }
});
