import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";

const { source, destination } = workerData as { source: string; destination: string };
const database = new DatabaseSync(source, { readOnly: true });
try {
  database.exec("PRAGMA busy_timeout=5000");
  await backup(database, destination, { rate: 256 });
  parentPort?.postMessage({ complete: true });
} finally {
  database.close();
}
