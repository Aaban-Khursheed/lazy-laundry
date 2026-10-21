#!/usr/bin/env node
// Evidence collector: runs every release gate, captures full logs per step,
// and writes a single observable bundle under test-results/evidence/<runId>/:
//   results.ndjson  — one JSON event per step (grep-friendly)
//   evidence.json   — full structured record (commands, exit codes, durations)
//   evidence.md     — human report
//   evidence.html   — self-contained dashboard (open in any browser)
// Exits non-zero if any executed step fails. Steps that cannot run locally
// are recorded as NOT_ESTABLISHED with the reason — never silently skipped.
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `evidence_${new Date().toISOString().replace(/[:.]/g, "-")}`;
// Keep evidence OUT of test-results/: Playwright wipes that directory on
// every run, which would delete logs mid-collection.
const runDir = join(root, "evidence", runId);
const logsDir = join(runDir, "logs");
mkdirSync(logsDir, { recursive: true });

const sha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
const lockHash = createHash("sha256").update(execSync("cat package-lock.json", { cwd: root })).digest("hex");

const STEPS = [
  { id: "db:check", command: "npm run db:check" },
  { id: "lint", command: "npm run lint" },
  { id: "unit", command: "npm run test" },
  { id: "build:ui", command: "npm run build:ui" },
  { id: "infra", command: "npm run test:infra" },
  { id: "integration", command: "npm run test:integration" },
  { id: "browser", command: "npm run test:e2e:infra" },
  { id: "bundle", command: "./node_modules/.bin/wrangler deploy --dry-run --env=''" },
];

const events = [];
const records = [];
let anyFailed = false;

for (const step of STEPS) {
  const startedAt = new Date();
  const proc = spawnSync(step.command, {
    cwd: root, shell: true, encoding: "utf8",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", LIBERAIT_RUN_DIR: runDir },
    timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const finishedAt = new Date();
  const output = `${proc.stdout || ""}${proc.stderr || ""}`;
  const logFile = `${step.id}.log`;
  writeFileSync(join(logsDir, logFile), output);
  const ok = proc.status === 0;
  if (!ok) anyFailed = true;
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const counts = /Tests\s+(\d+)\s+passed/i.exec(plain) || /(\d+)\s+passed/i.exec(plain);
  const record = {
    step: step.id,
    command: step.command,
    status: ok ? "PASS" : "FAIL",
    exitCode: proc.status ?? "signal",
    startedAt: startedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    testCount: counts ? Number(counts[1]) : null,
    logFile: `logs/${logFile}`,
    logBytes: Buffer.byteLength(output),
  };
  records.push(record);
  events.push({ ts: finishedAt.toISOString(), runId, ...record });
  console.log(`${ok ? "PASS" : "FAIL"} ${step.id} (${record.durationMs}ms) → logs/${logFile}`);
}

// Steps that structurally cannot run here — recorded, not hidden.
records.push({
  step: "legacy-e2e-shared-server",
  command: "npm run test:e2e",
  status: "NOT_ESTABLISHED",
  exitCode: null,
  startedAt: null,
  durationMs: 0,
  testCount: null,
  logFile: null,
  reason: "Targets the shared dev server on :8787; covered functionally by test:e2e:infra + test:integration. Runs in CI where the runner owns the dev server.",
});
records.push({
  step: "production-acceptance",
  command: "wrangler deploy + live probes",
  status: "NOT_ESTABLISHED",
  exitCode: null,
  startedAt: null,
  durationMs: 0,
  testCount: null,
  logFile: null,
  reason: "Requires the owner's Cloudflare credentials; local wrangler is not authorized for the account (API 7403).",
});

const summary = {
  runId,
  sourceSha: sha,
  dirtyWorktreeFiles: dirty,
  lockfileSha256: lockHash,
  node: process.version,
  recordedAt: new Date().toISOString(),
  steps: records,
  verdict: anyFailed ? "FAIL" : "PASS",
};

writeFileSync(join(runDir, "results.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(runDir, "evidence.json"), JSON.stringify(summary, null, 2) + "\n");

const md = [
  `# Evidence run ${runId}`,
  ``,
  `- source: \`${sha}\` (+${dirty} worktree files)`,
  `- lockfile sha256: \`${lockHash.slice(0, 16)}…\``,
  `- node: ${process.version}  • verdict: **${summary.verdict}**`,
  ``,
  `| Step | Status | Exit | Duration | Tests | Log |`,
  `|---|---|---|---|---|---|`,
  ...records.map((r) => `| ${r.step} | ${r.status} | ${r.exitCode ?? "—"} | ${r.durationMs}ms | ${r.testCount ?? "—"} | ${r.logFile ?? r.reason ?? ""} |`),
];
writeFileSync(join(runDir, "evidence.md"), md.join("\n") + "\n");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rows = records.map((r) => `
  <tr class="${r.status.toLowerCase().replace(/_/g, "-")}">
    <td>${esc(r.step)}</td><td><span class="chip">${r.status}</span></td>
    <td>${r.exitCode ?? "—"}</td><td>${r.durationMs}ms</td><td>${r.testCount ?? "—"}</td>
    <td>${r.logFile ? `<a href="${esc(r.logFile)}">log</a>` : esc(r.reason || "")}</td>
  </tr>`).join("");
const html = `<!doctype html><meta charset="utf-8"><title>Lazy Laundry evidence — ${runId}</title>
<style>body{font:14px/1.5 system-ui;background:#0f1216;color:#dfe5ee;max-width:1100px;margin:32px auto;padding:0 16px}
h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-top:16px}
td,th{border:1px solid #2a3140;padding:8px 10px;text-align:left;font-size:13px}
.chip{padding:2px 8px;border-radius:10px;font-weight:600;font-size:12px}
.pass .chip{background:#12391f;color:#5ee08a}.fail .chip{background:#4a1520;color:#ff7a8a}
.not-established .chip{background:#3d3413;color:#ffd479}code{font-size:12px;color:#9fd0ff}a{color:#9fd0ff}</style>
<h1>Lazy Laundry — release evidence</h1>
<div><code>${runId}</code> · sha <code>${sha}</code> · dirty files ${dirty} · node ${process.version} · verdict <b>${summary.verdict}</b></div>
<table><tr><th>Step</th><th>Status</th><th>Exit</th><th>Duration</th><th>Tests</th><th>Evidence</th></tr>${rows}
</table><p>Generated ${summary.recordedAt}. Full raw logs under <code>logs/</code> in this directory.</p>`;
writeFileSync(join(runDir, "evidence.html"), html);

console.log(`\nEvidence bundle: ${join(runDir)}\n  open ${join(runDir, "evidence.html")}\nVerdict: ${summary.verdict}`);
process.exit(anyFailed ? 1 : 0);
