const configuredBase = document.querySelector('meta[name="lazy-laundry-api-base"]')?.content.trim() || "";

export const API_BASE_URL = configuredBase.replace(/\/+$/, "");
export const API_MODE = API_BASE_URL.length > 0;

export async function apiRequest(path, { credentials, ...options } = {}) {
  const baseUrl = new URL(`${API_BASE_URL}/`);
  const endpoint = new URL(String(path).replace(/^\/+/, ""), baseUrl);
  const headers = new Headers(options.headers || {});
  let body = options.body;

  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(endpoint, {
      ...options,
      body,
      headers,
      ...(credentials ? { credentials } : {}),
    });
  } catch {
    throw new Error("Unable to reach the configured Lazy Laundry API. Check the connection and try again.");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : `Request failed with status ${response.status}.`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  return payload;
}
