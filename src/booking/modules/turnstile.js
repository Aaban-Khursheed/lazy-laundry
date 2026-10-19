let siteKeyPromise;
let scriptPromise;
let busy = false;

function retryError(message) {
  return new Error(`${message} Please try again.`);
}

async function readSiteKey(signal) {
  let response;
  try {
    response = await fetch("/api/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    throw retryError("Security check configuration could not be loaded.");
  }
  if (!response?.ok) throw retryError("Security check configuration request failed.");
  let config;
  try {
    config = await response.json();
  } catch {
    throw retryError("Security check configuration returned invalid JSON.");
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.hasOwn(config, "turnstileSiteKey")) {
    throw retryError("Security check configuration is invalid.");
  }
  const siteKey = config.turnstileSiteKey;
  if (siteKey === null || siteKey === "") return "";
  if (typeof siteKey !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(siteKey)) {
    throw retryError("Security check configuration has an invalid site key.");
  }
  return siteKey;
}

async function fetchSiteKey() {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(retryError("Security check configuration timed out."));
      controller.abort();
    }, 10000);
  });
  try {
    return await Promise.race([readSiteKey(controller.signal), deadline]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function getSiteKey() {
  siteKeyPromise ||= fetchSiteKey().catch((error) => {
    siteKeyPromise = undefined;
    throw error;
  });
  return siteKeyPromise;
}

function isReady(api) {
  return typeof api?.render === "function" && typeof api?.remove === "function";
}

function loadScript() {
  if (scriptPromise) return scriptPromise;
  if (isReady(window.turnstile)) return Promise.resolve(window.turnstile);
  scriptPromise = new Promise((resolve, reject) => {
    let script;
    let timeout;
    let settled = false;
    const finish = (error, api) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (script) {
        script.onload = null;
        script.onerror = null;
        if (error) {
          try {
            script.remove();
          } catch {
            error = retryError("Security check script could not be cleared.");
          }
        }
      }
      if (error) reject(error);
      else resolve(api);
    };
    try {
      script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      timeout = setTimeout(() => finish(retryError("Security check script timed out.")), 10000);
      script.onload = () => {
        const api = window.turnstile;
        finish(isReady(api) ? null : retryError("Security check script did not provide a working widget API."), api);
      };
      script.onerror = () => finish(retryError("Security check script could not be loaded."));
      document.head.appendChild(script);
    } catch {
      finish(retryError("Security check script could not be started."));
    }
  }).finally(() => {
    scriptPromise = undefined;
  });
  return scriptPromise;
}

function removeWidget(api, widgetId, container) {
  let error;
  if (widgetId !== undefined && widgetId !== null) {
    try {
      api.remove(widgetId);
    } catch {
      error = retryError("Security check widget could not be cleared.");
    }
  }
  if (container) {
    try {
      container.remove();
    } catch {
      error = retryError("Security check container could not be cleared.");
    }
  }
  if (error) throw error;
}

async function runWidget(api, siteKey, action) {
  let container;
  let widgetId;
  let timeout;
  let settled = false;
  try {
    try {
      container = document.createElement("div");
      container.className = "turnstile-challenge";
      container.setAttribute("aria-live", "polite");
      container.textContent = "Security check";
      document.body.appendChild(container);
    } catch {
      throw retryError("Security check could not be displayed.");
    }
    return await new Promise((resolve, reject) => {
      let rendering = true;
      let pending;
      const finish = (error, token) => {
        if (settled) return;
        if (rendering) {
          pending ||= { error, token };
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(token);
      };
      timeout = setTimeout(() => finish(retryError("Security check timed out.")), 20000);
      try {
        widgetId = api.render(container, {
          sitekey: siteKey,
          action,
          appearance: "interaction-only",
          retry: "never",
          "refresh-expired": "never",
          "refresh-timeout": "never",
          "response-field": false,
          callback: (token) => {
            if (typeof token !== "string" || token.length === 0 || token.length > 2048 || /\s/.test(token)) {
              finish(retryError("Security check returned an invalid token."));
            } else {
              finish(null, token);
            }
          },
          "expired-callback": () => finish(retryError("Security check expired.")),
          "error-callback": () => {
            finish(retryError("Security check failed."));
            return true;
          },
          "timeout-callback": () => finish(retryError("Security check interaction timed out.")),
        });
        if (widgetId === undefined || widgetId === null) {
          pending = { error: retryError("Security check did not create a widget.") };
        }
      } catch {
        pending = { error: retryError("Security check could not be started.") };
      }
      rendering = false;
      if (pending) finish(pending.error, pending.token);
    });
  } finally {
    settled = true;
    clearTimeout(timeout);
    removeWidget(api, widgetId, container);
  }
}

export async function getTurnstileToken(action) {
  if (typeof action !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(action)) {
    throw new Error("Security check action must contain 1-32 letters, numbers, underscores, or hyphens.");
  }
  if (busy) throw retryError("A security check is already in progress.");
  busy = true;
  try {
    const siteKey = await getSiteKey();
    if (!siteKey) return "";
    const api = await loadScript();
    return await runWidget(api, siteKey, action);
  } finally {
    busy = false;
  }
}
