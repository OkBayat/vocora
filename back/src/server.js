import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApp } from "./createApp.js";
import { loadConfig } from "./config/loadConfig.js";
import { createContainer } from "./container.js";
import { createPool } from "./infrastructure/persistence/mysql/createPool.js";

// Explicit process variables win. A back/.env file then takes precedence over
// the repository-root .env, matching the database setup command.
for (const environmentFile of [
  new URL("../.env", import.meta.url),
  new URL("../../.env", import.meta.url)
]) {
  loadEnvironment({
    path: fileURLToPath(environmentFile),
    override: false,
    quiet: true
  });
}

const config = loadConfig();
const pool = createPool(config.database);

await pool.query("SELECT 1");

const container = createContainer({ pool, config });
const app = createApp({
  container,
  nodeEnv: config.nodeEnv,
  trustProxy: config.trustProxy
});

const server = app.listen(config.port, () => {
  console.info(`Vazheyar is listening on port ${config.port}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`${signal} received; shutting down.`);

  server.close(async (error) => {
    await pool.end();
    process.exitCode = error ? 1 : 0;
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
