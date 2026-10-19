import { apiRequest } from "../../shared/api.js";

export function assertBooking(booking, expectedId) {
  if (!booking || typeof booking.id !== "string" || (expectedId && booking.id !== expectedId)) {
    throw new Error("The operator API returned an invalid booking response.");
  }
  return booking;
}

function validateMutation(validate) {
  try {
    return validate();
  } catch (error) {
    error.outcomeUnknown = true;
    throw error;
  }
}

export async function saveOperatorAction(kind, action, booking, fields = {}, penaltyId = "") {
  const path = `/api/operator/bookings/${encodeURIComponent(booking.id)}`;
  if (kind === "order") {
    if (!Number.isInteger(booking.revision) || booking.revision < 1) throw new Error("Booking revision is unavailable. Refresh the order before making changes.");
    const result = await apiRequest(path, { method: "PATCH", credentials: "include", body: { action, revision: booking.revision, ...fields }, timeoutMs: 15000 });
    return validateMutation(() => ({ booking: assertBooking(result?.booking, booking.id) }));
  }
  if (kind === "note") {
    const result = await apiRequest(`${path}/notes`, { method: "POST", credentials: "include", body: { note: fields.note }, timeoutMs: 15000 });
    return validateMutation(() => ({ booking: assertBooking(result?.booking, booking.id) }));
  }
  if (kind === "waive") {
    const result = await apiRequest(`/api/operator/penalties/${encodeURIComponent(penaltyId)}/waive`, { method: "POST", credentials: "include", body: { reason: fields.reason }, timeoutMs: 15000 });
    return validateMutation(() => {
      if (!result?.booking && result?.waived !== true) throw new Error("The operator API returned an invalid waiver response.");
      return result;
    });
  }
  if (kind === "tracking") {
    const result = await apiRequest(`${path}/${action}`, { method: "POST", credentials: "include", body: action === "share" ? {} : { reason: fields.reason }, timeoutMs: 15000 });
    return validateMutation(() => {
      if (action === "revoke") {
        if (result?.revoked !== true) throw new Error("The operator API returned an invalid revocation response.");
      } else {
        if (typeof result?.trackingLink !== "string") throw new Error("The operator API returned an invalid tracking response.");
        const url = new URL(result.trackingLink);
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (!["https:", "http:"].includes(url.protocol) || url.search || url.username || url.password || !fragment.get("number") || !fragment.get("token")) {
          throw new Error("The operator API returned an invalid tracking link.");
        }
      }
      return result;
    });
  }
  throw new Error("Unsupported operator action.");
}

export async function savePromotion(fields, editing = null) {
  const path = editing ? `/api/operator/promotions/${encodeURIComponent(editing.id)}` : "/api/operator/promotions";
  const body = editing ? { revision: editing.revision, fields } : fields;
  const result = await apiRequest(path, { method: editing ? "PATCH" : "POST", credentials: "include", body, timeoutMs: 15000 });
  return validateMutation(() => {
    if (!result?.promotion || typeof result.promotion.id !== "string" || !Number.isInteger(result.promotion.revision)) {
      throw new Error("The operator API returned an invalid promotion response.");
    }
    return result.promotion;
  });
}

export async function exportOperatorBookings(status, signal, date = "") {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const params = new URLSearchParams({ status, limit: "100", ...(date ? { date } : {}) });
  try {
    const response = await fetch(`/api/operator/export?${params}`, {
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "text/csv",
        ...(window.location.hostname === "ops.localhost" ? { "X-Local-Operator-Email": "local.operator@example.invalid" } : {}),
      },
    });
    if (!response.ok || !response.headers.get("Content-Type")?.includes("text/csv")) throw new Error("The operator export could not be downloaded. Check your authorization and try again.");
    const blob = await response.blob();
    if (controller.signal.aborted) return;
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "lazy-laundry-bookings.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error("CSV download timed out. Try exporting again.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
