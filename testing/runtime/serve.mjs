import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { startHarness } from "./harness.mjs";

const runDir = process.env.LIBERAIT_RUN_DIR;
const runId = process.env.LIBERAIT_RUN_ID;
if (!runDir || !isAbsolute(runDir) || !/^[a-zA-Z0-9_-]+$/.test(runId || "")) {
  throw new Error("An absolute run directory and safe run ID are required");
}
const sandbox = await startHarness({ customerOrigin: process.env.BASE_URL });
try {
  await writeFile(
    join(runDir, "runtime.json"),
    JSON.stringify({ runId, pid: process.pid, url: sandbox.url.href }, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(`Isolated runtime ready: ${sandbox.url.origin}`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await sandbox.close();
}
