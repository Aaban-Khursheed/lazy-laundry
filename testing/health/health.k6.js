import http from "k6/http";
import { check, sleep } from "k6";

const base = __ENV.BASE_URL || "";
const target = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(base);
if (!target || Number(target[2]) < 1 || Number(target[2]) > 65535) {
  throw new Error("Only an explicit loopback HTTP target is allowed");
}
if (!/^[a-zA-Z0-9_-]+$/.test(__ENV.LIBERAIT_RUN_ID || "")) {
  throw new Error("A safe run ID is required");
}
const startAt = Number(__ENV.START_AT_MS || 0);
if (!Number.isFinite(startAt) || startAt < 0
  || startAt > Date.now() + 20000) {
  throw new Error("Invalid or unbounded start time");
}

export const options = {
  scenarios: {
    health: {
      executor: "per-vu-iterations",
      vus: 2,
      iterations: 1,
      maxDuration: "30s",
      gracefulStop: "0s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
  },
};

export default function () {
  if (startAt > Date.now()) sleep((startAt - Date.now()) / 1000);
  const response = http.get(`${base}/api/health`, {
    timeout: "3s",
    redirects: 0,
    headers: {
      "X-Liberait-Run-Id": __ENV.LIBERAIT_RUN_ID,
    },
    tags: { name: "GET /api/health" },
  });
  check(response, {
    "health returns ready": (r) => {
      if (r.status !== 200) return false;
      try { return r.json("status") === "ok"; } catch { return false; }
    },
  });
}
