import fs from "fs";
import path from "path";

/**
 * Load settings from a `.env` file in the project root, if there is one.
 *
 * Imported first by `server/index.ts` so the values are in place before anything
 * reads them. Variables already set in the shell (`$env:PORT = ...`,
 * `export PORT=...`) win over the file.
 */
const envPath = path.resolve(process.cwd(), ".env");

if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
