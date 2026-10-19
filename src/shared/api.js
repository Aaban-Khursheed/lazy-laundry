const configuredBase = document.querySelector('meta[name="lazy-laundry-api-base"]')?.content.trim() || window.location.origin;

export const API_BASE_URL = configuredBase.replace(/\/+$/, "");
export const API_MODE = true;

export async function apiRequest(path, { credentials = "same-origin", timeoutMs = 15000, readOnly = false, signal, ...options } = {}) {
  const endpoint = new URL(String(path).replace(/^\/+/, ""), `${API_BASE_URL}/`);
  if (endpoint.origin !== window.location.origin) throw new Error("The service must use this app's origin.");
  const method = (options.method || "GET").toUpperCase();
  const mutation = !readOnly && !["GET", "HEAD"].includes(method) && !["/api/track", "/api/estimate", "/api/operator/bookings/search"].includes(endpoint.pathname);
  const headers = new Headers(options.headers || {});
  if (window.location.hostname === "ops.localhost") headers.set("X-Local-Operator-Email", "local.operator@example.invalid");
  let body = options.body;
  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Request cancelled", "AbortError"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 15000);
  let rejectAborted;
  const aborted = new Promise((resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAborted();
    else controller.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  const request = async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetch(endpoint, { ...options, body, headers, credentials, signal: controller.signal });
    let payload;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      payload = null;
    }
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`;
      throw Object.assign(new Error(message), {
        status: response.status,
        code: typeof payload?.code === "string" ? payload.code : "request_failed",
        outcomeUnknown: mutation && response.status >= 500,
      });
    }
    if (!payload || typeof payload !== "object") throw Object.assign(new Error("The service returned an invalid response. Please retry."), { code: "invalid_response", outcomeUnknown: mutation });
    return payload;
  };
  try {
    return await Promise.race([request(), aborted]);
  } catch (error) {
    if (Number.isInteger(error?.status) || typeof error?.code === "string") throw error;
    if (signal?.aborted) throw Object.assign(new DOMException("Request cancelled", "AbortError"), { outcomeUnknown: mutation });
    const message = timedOut ? "The service took too long to respond. Please retry." : "Unable to reach Lazy Laundry. Check the connection and try again.";
    throw Object.assign(new Error(message), { code: timedOut ? "request_timeout" : "network_error", outcomeUnknown: mutation });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAborted);
  }
}
