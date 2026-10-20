#!/usr/bin/env node
// Static guardrail for api/migrations/. Migrations apply once and are never
// undone by a Worker rollback, so destructive statements must be a deliberate,
// reviewed act. Reviewed historical exceptions live in BASELINE_REVIEWED below;
// a new migration that trips a flagged pattern fails until a reviewer adds it
// to that list with justification.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "api", "migrations");

// Files whose flagged statements were already reviewed and applied. Do not add
// entries without recording why the destructive statement is safe.
const BASELINE_REVIEWED = new Map([
  ["0003_launch_foundation.sql", "SQLite table rebuild: bookings -> bookings_next rename plus backfill; reviewed at launch"],
  ["0005_booking_edit_events.sql", "booking_events rebuild for edit events; reviewed"],
  ["0010_capacity_audit.sql", "DROP INDEX + recreate for partial active-block uniqueness; reviewed"],
]);

// Statements that are never acceptable in any migration.
const FORBIDDEN = [
  { re: /\bDELETE\s+FROM\b/i, label: "DELETE FROM" },
  { re: /\bUPDATE\s+[a-zA-Z_][\w]*\s+SET\b/i, label: "UPDATE ... SET" },
  { re: /\bREPLACE\s+INTO\b|\bINSERT\s+OR\s+REPLACE\b/i, label: "REPLACE INTO" },
  { re: /\bPRAGMA\s+writable_schema\b/i, label: "PRAGMA writable_schema" },
  { re: /\bATTACH\b|\bDETACH\b/i, label: "ATTACH/DETACH" },
  { re: /\bDROP\s+COLUMN\b|\bALTER\s+TABLE\b[^;]*\bDROP\b/i, label: "DROP COLUMN / ALTER ... DROP" },
];

// Patterns allowed only in BASELINE_REVIEWED files.
const REVIEW_GATED = [
  { re: /\bDROP\s+TABLE\b/i, label: "DROP TABLE" },
  { re: /\bDROP\s+(INDEX|VIEW|TRIGGER)\b/i, label: "DROP INDEX/VIEW/TRIGGER" },
  { re: /\bRENAME\s+(TO|COLUMN)\b/i, label: "RENAME" },
];

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`db:check: no migrations found in ${migrationsDir}`);
  process.exit(1);
}

let failed = false;
let lastPrefix = -1;
for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    console.error(`db:check FAIL ${file}: filename must be NNNN_lowercase_name.sql`);
    failed = true;
    continue;
  }
  const prefix = Number(match[1]);
  if (prefix <= lastPrefix) {
    console.error(`db:check FAIL ${file}: migration prefixes must be strictly increasing`);
    failed = true;
  }
  lastPrefix = prefix;

  const body = stripComments(readFileSync(join(migrationsDir, file), "utf8"));
  for (const { re, label } of FORBIDDEN) {
    if (re.test(body)) {
      console.error(`db:check FAIL ${file}: forbidden statement ${label}`);
      failed = true;
    }
  }
  for (const { re, label } of REVIEW_GATED) {
    if (re.test(body)) {
      const why = BASELINE_REVIEWED.get(file);
      if (why) {
        console.log(`db:check ok   ${file}: ${label} (reviewed: ${why})`);
      } else {
        console.error(`db:check FAIL ${file}: ${label} requires review — add to BASELINE_REVIEWED in scripts/check-migrations.mjs with justification`);
        failed = true;
      }
    }
  }
}

// Every d1_databases entry in wrangler.jsonc must point at the same dir we scanned.
const wranglerRaw = readFileSync(join(root, "wrangler.jsonc"), "utf8");
const wranglerJson = JSON.parse(wranglerRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1"));
const seen = [];
const collect = (node) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(collect);
  if (Array.isArray(node.d1_databases)) node.d1_databases.forEach((d) => d.migrations_dir && seen.push(d.migrations_dir));
  Object.values(node).forEach(collect);
};
collect(wranglerJson);
for (const dir of new Set(seen)) {
  if (dir !== "api/migrations") {
    console.error(`db:check FAIL: wrangler.jsonc migrations_dir '${dir}' != 'api/migrations'`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`db:check PASS: ${files.length} migrations, prefixes 0001-${String(lastPrefix).padStart(4, "0")}, config consistent`);
