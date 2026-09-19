import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.js";

export async function externalBackupHealth() {
  const read = async (path: string) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      const timestamp = Date.parse(
        value.last_success_at ?? value.completed_at ?? value.verified_at ?? "",
      );
      const lastSuccess =
        Number.isFinite(timestamp) && timestamp <= Date.now() + 60_000 ? timestamp : 0;
      return {
        configured: true,
        status:
          value.status === "healthy" && lastSuccess > 0 && Date.now() - lastSuccess < 36 * 3600_000
            ? "healthy"
            : "degraded",
        last_success_at: lastSuccess ? new Date(lastSuccess).toISOString() : null,
        last_success_timestamp_seconds: Math.floor(lastSuccess / 1000),
        last_result: value.status === "healthy" ? "succeeded" : "failed",
        scope: value.scope === "offsite" ? "offsite" : "external_unverified",
        restore_verified: value.restore_verified === true,
      };
    } catch {
      return {
        configured: false,
        status: "not_configured",
        last_success_at: null,
        last_success_timestamp_seconds: 0,
        last_result: "not_run",
        scope: "external_unverified",
        restore_verified: false,
      };
    }
  };
  const [backup, restore] = await Promise.all([
    read(config.backupStatusFile),
    read(join(dirname(config.backupStatusFile), "restore.json")),
  ]);
  return { backup, restore, required: process.env.OFFSITE_BACKUP_REQUIRED === "true" };
}
