import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SITE_KEY = "public-test-site-key";
let getTurnstileToken;
let fetchMock;
let head;
let body;
let api;
let widgets;

function element(tagName) {
  return {
    tagName,
    children: [],
    parentNode: null,
    setAttribute: vi.fn(),
    appendChild: vi.fn(function (child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }),
    remove: vi.fn(function () {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
    }),
  };
}

function response(config = { turnstileSiteKey: SITE_KEY }) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(config) };
}

function observe(promise) {
  const result = { status: "pending" };
  promise.then(
    (value) => Object.assign(result, { status: "fulfilled", value }),
    (error) => Object.assign(result, { status: "rejected", error }),
  );
  return result;
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function expectError(result, pattern = /security check.*try again/i) {
  await flush();
  expect(result.status).toBe("rejected");
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error.message).toMatch(pattern);
}

async function expectToken(result, token) {
  await flush();
  expect(result.status).toBe("fulfilled");
  expect(result.value).toBe(token);
}

async function startWidget(action = "booking") {
  window.turnstile = api;
  const result = observe(getTurnstileToken(action));
  await flush();
  expect(widgets.length).toBeGreaterThan(0);
  return result;
}

async function completeRetry(action = "cancel") {
  const result = await startWidget(action);
  widgets.at(-1).options.callback(`synthetic-${action}-token`);
  await expectToken(result, `synthetic-${action}-token`);
  expect(body.children).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  head = element("head");
  body = element("body");
  widgets = [];
  api = {
    render: vi.fn((container, options) => {
      const id = `widget-${widgets.length + 1}`;
      widgets.push({ id, container, options });
      return id;
    }),
    remove: vi.fn(),
  };
  fetchMock = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { head, body, createElement: vi.fn(element) });
  ({ getTurnstileToken } = await import("../public/booking/modules/turnstile.js"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Turnstile public configuration", () => {
  it.each([null, ""])("allows only a successfully declared no-sitekey value %j", async (siteKey) => {
    fetchMock.mockResolvedValue(response({ turnstileSiteKey: siteKey }));
    await expectToken(observe(getTurnstileToken("booking")), "");
    await expectToken(observe(getTurnstileToken("cancel")), "");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.createElement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["network failure", () => Promise.reject(new TypeError("offline"))],
    ["HTTP failure", () => Promise.resolve({ ok: false, status: 503, json: vi.fn() })],
    ["invalid JSON", () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("invalid")) })],
    ...[undefined, null, [], {}, { turnstileSiteKey: false }, { turnstileSiteKey: 12 },
      { turnstileSiteKey: {} }, { turnstileSiteKey: " " }, { turnstileSiteKey: " padded " },
      { turnstileSiteKey: `${SITE_KEY}\n` }, { turnstileSiteKey: "x".repeat(257) }].map((config) => [
      `invalid schema ${JSON.stringify(config)}`,
      () => Promise.resolve({ ok: true, status: 200, json: vi.fn().mockResolvedValue(config) }),
    ]),
  ])("rejects %s and clears the configuration cache for retry", async (_name, failure) => {
    fetchMock.mockImplementationOnce(failure);
    const result = observe(getTurnstileToken("booking"));
    await expectError(result, /configuration.*try again/i);
    expect(head.children).toHaveLength(0);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds an unresponsive fetch, aborts it, and ignores its late configuration", async () => {
    let resolveFetch;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const result = observe(getTurnstileToken("booking"));
    await flush();
    const options = fetchMock.mock.calls[0][1];
    expect(fetchMock.mock.calls[0][0]).toBe("/api/config");
    expect(options.credentials).toBe("same-origin");
    expect(options.headers.Accept).toBe("application/json");
    await vi.advanceTimersByTimeAsync(9999);
    expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expectError(result, /configuration.*timed out.*try again/i);
    expect(options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockResolvedValue(response({ turnstileSiteKey: null }));
    await expectToken(observe(getTurnstileToken("cancel")), "");
    resolveFetch(response());
    await flush();
    await expectToken(observe(getTurnstileToken("reschedule")), "");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(head.children).toHaveLength(0);
  });

  it("includes a stalled JSON body in the configuration deadline", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    const result = observe(getTurnstileToken("estimate"));
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    await expectError(result, /configuration.*timed out.*try again/i);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await completeRetry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Turnstile script loading", () => {
  it("bounds a stalled script, removes it, retries, and fences late events", async () => {
    const result = observe(getTurnstileToken("booking"));
    await flush();
    const firstScript = head.children[0];
    const lateLoad = firstScript.onload;
    const lateError = firstScript.onerror;
    expect(firstScript.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(firstScript.async).toBe(true);
    expect(firstScript.defer).toBe(true);
    await vi.advanceTimersByTimeAsync(9999);
    expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expectError(result, /script.*timed out.*try again/i);
    expect(firstScript.remove).toHaveBeenCalledTimes(1);
    expect(firstScript.onload).toBeNull();
    expect(firstScript.onerror).toBeNull();
    expect(head.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const retry = observe(getTurnstileToken("cancel"));
    await flush();
    const secondScript = head.children[0];
    expect(secondScript).not.toBe(firstScript);
    window.turnstile = api;
    lateLoad();
    lateError();
    await flush();
    expect(retry.status).toBe("pending");
    expect(api.render).not.toHaveBeenCalled();
    expect(head.children).toEqual([secondScript]);
    secondScript.onload();
    await flush();
    expect(widgets[0].options.action).toBe("cancel");
    widgets[0].options.callback("synthetic-retry-token");
    await expectToken(retry, "synthetic-retry-token");
    expect(api.remove).toHaveBeenCalledWith(widgets[0].id);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a CDN error with a retryable Error instead of an event", async () => {
    const result = observe(getTurnstileToken("booking"));
    await flush();
    const script = head.children[0];
    script.onerror({ type: "error" });
    await expectError(result, /script.*try again/i);
    expect(script.remove).toHaveBeenCalledTimes(1);
    expect(script.onload).toBeNull();
    expect(script.onerror).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const retry = observe(getTurnstileToken("reschedule"));
    await flush();
    expect(head.children).toHaveLength(1);
    window.turnstile = api;
    head.children[0].onload();
    await flush();
    widgets[0].options.callback("synthetic-reschedule-token");
    await expectToken(retry, "synthetic-reschedule-token");
  });

  it.each([undefined, {}, { render: () => {} }])("rejects an incomplete loaded API %j and reloads on retry", async (loadedApi) => {
    const result = observe(getTurnstileToken("booking"));
    await flush();
    const firstScript = head.children[0];
    window.turnstile = loadedApi;
    firstScript.onload();
    await expectError(result, /script.*try again/i);
    expect(firstScript.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const retry = observe(getTurnstileToken("cancel"));
    await flush();
    expect(head.children).toHaveLength(1);
    window.turnstile = api;
    head.children[0].onload();
    await flush();
    widgets[0].options.callback("synthetic-loaded-token");
    await expectToken(retry, "synthetic-loaded-token");
  });

  it("cleans up a script insertion failure and permits another load", async () => {
    head.appendChild.mockImplementationOnce(() => { throw new Error("DOM insertion failed"); });
    const result = observe(getTurnstileToken("booking"));
    await expectError(result, /script.*try again/i);
    expect(vi.getTimerCount()).toBe(0);
    const firstScript = document.createElement.mock.results[0].value;
    expect(firstScript.remove).toHaveBeenCalledTimes(1);
    const retry = observe(getTurnstileToken("cancel"));
    await flush();
    window.turnstile = api;
    head.children[0].onload();
    await flush();
    widgets[0].options.callback("synthetic-insertion-retry-token");
    await expectToken(retry, "synthetic-insertion-retry-token");
  });
});

describe("Turnstile widget lifecycle", () => {
  it("returns a bounded token and removes a fresh widget for each action", async () => {
    const first = await startWidget("booking");
    expect(widgets[0].container.className).toBe("turnstile-challenge");
    expect(widgets[0].container.setAttribute).toHaveBeenCalledWith("aria-live", "polite");
    expect(widgets[0].options).toMatchObject({
      sitekey: SITE_KEY,
      action: "booking",
      appearance: "interaction-only",
      retry: "never",
      "refresh-expired": "never",
      "refresh-timeout": "never",
      "response-field": false,
    });
    widgets[0].options.callback("x".repeat(2048));
    await expectToken(first, "x".repeat(2048));
    expect(api.remove).toHaveBeenCalledWith(widgets[0].id);
    expect(widgets[0].container.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toHaveLength(0);
    await completeRetry("reschedule");
    expect(widgets[1].container).not.toBe(widgets[0].container);
    expect(widgets[1].id).not.toBe(widgets[0].id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it.each(["expired-callback", "error-callback", "timeout-callback"])("rejects %s, removes the widget, and allows retry", async (callback) => {
    const result = await startWidget();
    const firstWidget = widgets[0];
    expect(firstWidget.options[callback]).toBeTypeOf("function");
    const handled = firstWidget.options[callback]();
    if (callback === "error-callback") expect(handled).toBe(true);
    await expectError(result);
    expect(api.remove).toHaveBeenCalledWith(firstWidget.id);
    expect(firstWidget.container.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects the 20-second widget deadline and ignores stale callbacks during retry", async () => {
    const result = await startWidget();
    const firstWidget = widgets[0];
    await vi.advanceTimersByTimeAsync(19999);
    expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expectError(result, /security check.*timed out.*try again/i);
    expect(api.remove).toHaveBeenCalledWith(firstWidget.id);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const retry = await startWidget("cancel");
    firstWidget.options.callback("synthetic-stale-booking-token");
    firstWidget.options["expired-callback"]();
    firstWidget.options["error-callback"]();
    await flush();
    expect(retry.status).toBe("pending");
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([widgets[1].container]);
    widgets[1].options.callback("synthetic-cancel-token");
    await expectToken(retry, "synthetic-cancel-token");
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, 42, {}, "", " ", " padded ", "internal space", "x".repeat(2049)])("rejects invalid token %j without returning an unverified value", async (token) => {
    const result = await startWidget();
    widgets[0].options.callback(token);
    await expectError(result, /security check.*token.*try again/i);
    expect(api.remove).toHaveBeenCalledWith(widgets[0].id);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
  });

  it("rejects render exceptions and removes the container before retry", async () => {
    window.turnstile = api;
    api.render.mockImplementationOnce(() => { throw new Error("render failed"); });
    const result = observe(getTurnstileToken("booking"));
    await expectError(result);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
  });

  it("removes a widget whose success callback runs before render returns its ID", async () => {
    api.render.mockImplementationOnce((container, options) => {
      widgets.push({ id: "synchronous-widget", container, options });
      options.callback("synthetic-synchronous-token");
      return "synchronous-widget";
    });
    const result = await startWidget();
    await expectToken(result, "synthetic-synchronous-token");
    expect(api.remove).toHaveBeenCalledWith("synchronous-widget");
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects render throwing after a synchronous callback", async () => {
    window.turnstile = api;
    api.render.mockImplementationOnce((_container, options) => {
      options.callback("synthetic-premature-token");
      throw new Error("render failed after callback");
    });
    await expectError(observe(getTurnstileToken("booking")));
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
  });

  it("uses the captured API for removal even if the window API changes", async () => {
    const result = await startWidget();
    const replacement = { render: vi.fn(), remove: vi.fn() };
    window.turnstile = replacement;
    widgets[0].options.callback("synthetic-captured-api-token");
    await expectToken(result, "synthetic-captured-api-token");
    expect(api.remove).toHaveBeenCalledWith(widgets[0].id);
    expect(replacement.remove).not.toHaveBeenCalled();
  });

  it("cleans the container and releases the busy guard if API removal throws", async () => {
    const result = await startWidget();
    api.remove.mockImplementationOnce(() => { throw new Error("remove failed"); });
    widgets[0].options.callback("synthetic-token");
    await expectError(result);
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
  });

  it("cleans up after container insertion fails and releases the busy guard", async () => {
    window.turnstile = api;
    body.appendChild.mockImplementationOnce(() => { throw new Error("container insertion failed"); });
    await expectError(observe(getTurnstileToken("booking")));
    expect(body.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await completeRetry();
  });
});

describe("Turnstile action isolation", () => {
  it.each([undefined, null, 42, {}, "", "a".repeat(33), "with space", "with.dot", "é", "booking\n"])("rejects invalid action %j before any request", async (action) => {
    await expectError(observe(getTurnstileToken(action)), /action.*1.*32/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["a", "A_1-b", "a".repeat(32)])("passes valid action %s unchanged to a fresh widget", async (action) => {
    const result = await startWidget(action);
    expect(widgets[0].options.action).toBe(action);
    widgets[0].options.callback("synthetic-action-token");
    await expectToken(result, "synthetic-action-token");
  });

  it.each(["configuration", "script", "widget"])("explicitly rejects parallel calls during %s without mixing actions", async (phase) => {
    let resolveFetch;
    if (phase === "configuration") {
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    }
    if (phase === "widget") window.turnstile = api;
    const first = observe(getTurnstileToken("booking"));
    await flush();
    await expectError(observe(getTurnstileToken("cancel")), /security check.*in progress.*try again/i);
    if (resolveFetch) {
      resolveFetch(response());
      await flush();
    }
    if (phase !== "widget") {
      window.turnstile = api;
      head.children[0].onload();
      await flush();
    }
    expect(widgets).toHaveLength(1);
    expect(widgets[0].options.action).toBe("booking");
    widgets[0].options.callback("synthetic-booking-token");
    await expectToken(first, "synthetic-booking-token");
    await completeRetry("reschedule");
    expect(widgets[1].options.action).toBe("reschedule");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
