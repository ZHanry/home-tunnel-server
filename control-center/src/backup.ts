import { chmodSync, mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { open, rename, stat } from "node:fs/promises";
import { config } from "./config.js";
import { backupDatabase, one, query } from "./db.js";

const backupFilePattern = /^control-center-\d{8}T\d{6}Z\.sqlite3$/;

let running = false;

// Unix milliseconds of the most recent successful backup in this process,
// 0 when none has completed yet. Exposed through /internal/metrics.
export async function backupLastSuccessAt(): Promise<number> {
  const row = await one<{ last_success_at: Date | null }>(
    "SELECT last_success_at FROM maintenance_tasks WHERE name='local_snapshot'",
  );
  return row?.last_success_at?.getTime() ?? 0;
}

export async function localBackupHealth(): Promise<Record<string, unknown>> {
  const task = await one<{
    status: string;
    started_at: Date;
    completed_at: Date | null;
    last_success_at: Date | null;
    details: string;
  }>("SELECT * FROM maintenance_tasks WHERE name='local_snapshot'");
  if (!task) return { status: backupsEnabled() ? "unknown" : "disabled", scope: "local_snapshot" };
  const age = task.last_success_at
    ? Math.max(0, (Date.now() - task.last_success_at.getTime()) / 1000)
    : null;
  const stale = age === null || age > Math.max(36, config.backup.intervalHours * 1.5) * 3600;
  const stalled = task.status === "running" && Date.now() - task.started_at.getTime() > 300_000;
  return {
    scope: "local_snapshot",
    status: task.status === "failed" || stale || stalled ? "degraded" : "healthy",
    last_run_status: task.status,
    started_at: task.started_at,
    completed_at: task.completed_at,
    last_success_at: task.last_success_at,
    age_seconds: age,
    ...JSON.parse(task.details),
  };
}

export function backupsEnabled(): boolean {
  return (
    config.database.path !== ":memory:" &&
    config.backup.intervalHours > 0 &&
    config.backup.directory !== ""
  );
}

function backupFileName(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
  return `control-center-${stamp}.sqlite3`;
}

export async function runDatabaseBackup(
  now = new Date(),
): Promise<{ path: string; deletedCount: number }> {
  if (!config.backup.directory) {
    throw new Error(
      "Database backups require a file-backed database or an explicit BACKUP_DIRECTORY",
    );
  }
  if (running) throw new Error("Database backup is already running");
  running = true;
  const temporaryPath = join(config.backup.directory, `.snapshot-${randomUUID()}.part`);
  try {
    await query(`INSERT INTO maintenance_tasks(name,status,started_at) VALUES('local_snapshot','running',home_tunnel_now())
    ON CONFLICT(name) DO UPDATE SET status='running',started_at=excluded.started_at,completed_at=NULL,details='{}'`);
    mkdirSync(config.backup.directory, { recursive: true, mode: 0o700 });
    const targetPath = join(config.backup.directory, backupFileName(now));
    const placeholder = await open(temporaryPath, "wx", 0o600);
    await placeholder.close();
    await backupDatabase(temporaryPath);
    chmodSync(temporaryPath, 0o600);
    const snapshot = new DatabaseSync(temporaryPath);
    try {
      snapshot.exec("PRAGMA journal_mode=DELETE");
      if (snapshot.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new Error("Snapshot integrity check failed");
      if (snapshot.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Snapshot foreign key check failed");
    } finally {
      snapshot.close();
    }
    await rename(temporaryPath, targetPath);
    const size = (await stat(targetPath)).size;
    // File names embed a UTC timestamp, so the lexicographic order is the
    // chronological order; everything beyond the newest retentionCount goes.
    const snapshots = (await readdir(config.backup.directory))
      .filter((name) => backupFilePattern.test(name))
      .sort();
    const excess = Math.max(0, snapshots.length - config.backup.retentionCount);
    for (let index = 0; index < excess; index += 1) {
      await unlink(join(config.backup.directory, snapshots[index]!));
    }
    await query(
      "UPDATE maintenance_tasks SET status='healthy',completed_at=home_tunnel_now(),last_success_at=home_tunnel_now(),details=? WHERE name='local_snapshot'",
      [JSON.stringify({ size_bytes: size, integrity_verified: true })],
    );
    return { path: targetPath, deletedCount: excess };
  } catch (error) {
    await query(
      "UPDATE maintenance_tasks SET status='failed',completed_at=home_tunnel_now(),details=? WHERE name='local_snapshot'",
      [JSON.stringify({ error_code: "BACKUP_FAILED" })],
    );
    throw error;
  } finally {
    running = false;
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function startDatabaseBackups(): { close: () => void } {
  if (!backupsEnabled()) return { close: () => undefined };
  let closed = false;
  const execute = () => {
    if (closed) return;
    void runDatabaseBackup()
      .then(({ path, deletedCount }) => {
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            component: "control-center",
            event_code: "BACKUP_COMPLETED",
            path,
            deleted_count: deletedCount,
          }),
        );
      })
      .catch((error) =>
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            component: "control-center",
            event_code: "BACKUP_FAILED",
            message: error instanceof Error ? error.message : "Unknown backup error",
          }),
        ),
      );
  };
  const initialTimer = setTimeout(execute, 60_000);
  const intervalTimer = setInterval(execute, config.backup.intervalHours * 60 * 60 * 1000);
  initialTimer.unref();
  intervalTimer.unref();
  return {
    close: () => {
      closed = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}
