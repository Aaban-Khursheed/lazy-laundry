const STATUS_CODES = [
  "confirmed",
  "pickup_on_the_way",
  "laundry_picked_up",
  "processing",
  "ready",
  "delivered",
];

const STATUS_LABELS = {
  confirmed: "Confirmed",
  pickup_on_the_way: "Pickup on the way",
  laundry_picked_up: "Laundry picked up",
  processing: "Processing",
  ready: "Ready",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const SERVICE_LABELS = {
  standard: "Lazy Wash",
  express: "Lazy Wash Express",
};

const PAYMENT_LABELS = {
  cash: "Cash at pickup",
  qr: "QR at pickup",
};

const BLOCKS = new Set(["Block A/B", "Block C", "Block E", "Colonial"]);
const UNIT_PREFIXES = { "Block A/B": ["A", "B"], "Block C": ["C"], "Block E": ["E"], Colonial: ["C"] };
const MAX_BODY_BYTES = 16 * 1024;
const CUSTOMER_ASSET_PREFIXES = ["/booking/", "/shared/", "/legal/"];
const OPERATOR_ASSET_PREFIXES = ["/operator/", "/shared/"];

function securityHeaders({ api = false, operator = false } = {}) {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": operator ? "no-referrer" : "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=300",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(api ? { "Cache-Control": "no-store" } : {}),
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}, options = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...securityHeaders({ api: true, operator: options.operator }),
      ...extraHeaders,
    },
  });
}

function csvCell(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safeText = /^[=+\-@\t]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function csvResponse(rows, cors) {
  const headers = ["Booking number", "Pickup date", "Pickup slot", "Status", "Customer name", "Phone", "Block", "Unit", "Package size", "Service", "Total (RM)", "Payment status"];
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new Response(`${body}\r\n`, {
    status: 200,
    headers: {
      ...securityHeaders({ api: true, operator: true }),
      ...cors,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"lazy-laundry-bookings.csv\"",
    },
  });
}

function hostRole(request, env) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const customerHosts = new Set((env.CUSTOMER_HOSTS || "lazylaundry.me,www.lazylaundry.me").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const operatorHost = (env.OPERATOR_HOST || "ops.lazylaundry.me").trim().toLowerCase();
  if (customerHosts.has(hostname) || (env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1"].includes(hostname))) return "customer";
  if (hostname === operatorHost || (env.ENVIRONMENT === "local" && hostname === "ops.localhost")) return "operator";
  return null;
}

function withResponseHeaders(response, headers) {
  const merged = new Headers(response.headers);
  Object.entries(headers).forEach(([name, value]) => merged.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

async function serveAsset(request, env, role) {
  if (!env.ASSETS || !["GET", "HEAD"].includes(request.method)) {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
  }
  const incoming = new URL(request.url);
  let pathname = incoming.pathname;
  if (role === "customer" && (pathname === "/" || pathname === "/index.html" || pathname === "/track" || pathname === "/track/")) {
    pathname = "/booking/index.html";
  }
  if (role === "operator" && (pathname === "/" || pathname === "/index.html")) {
    pathname = "/operator/index.html";
  }
  if (/[\\\\]|%2f|%5c|%2e/i.test(pathname) || pathname.split("/").includes("..")) {
    return jsonResponse({ error: "Not found" }, 404);
  }
  const prefixes = role === "operator" ? OPERATOR_ASSET_PREFIXES : CUSTOMER_ASSET_PREFIXES;
  if (!prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix)) || pathname === "/booking/modules/operator.js" && role === "customer") {
    return jsonResponse({ error: "Not found" }, 404);
  }
  const assetUrl = new URL(incoming);
  assetUrl.pathname = pathname;
  const assetRequest = new Request(assetUrl, request);
  const response = await env.ASSETS.fetch(assetRequest);
  return withResponseHeaders(response, securityHeaders({ operator: role === "operator" }));
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const hosts = [
    ...(env.CUSTOMER_HOSTS || "").split(","),
    env.OPERATOR_HOST || "",
  ].map((value) => value.trim().toLowerCase()).filter(Boolean);
  const allowedOrigins = new Set([
    env.CUSTOMER_ORIGIN,
    env.OPERATOR_ORIGIN,
    ...hosts.map((host) => `https://${host}`),
    ...(env.ENVIRONMENT === "local" ? ["http://localhost:8787", "http://127.0.0.1:8787", "http://ops.localhost:8787"] : []),
  ].filter(Boolean));
  if (!allowedOrigins.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Idempotency-Key, X-Turnstile-Token, X-Local-Operator-Email",
    "Access-Control-Max-Age": "300",
    Vary: "Origin",
  };
}

function mutationRequestError(request) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return null;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) return "Origin is not allowed";
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return "Cross-origin requests are not allowed";
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return "JSON is required";
  return null;
}

async function enforceRateLimit(request, env, route) {
  if (!env.RATE_LIMITER) return { ok: env.ENVIRONMENT === "local", configured: false };
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  try {
    const result = await env.RATE_LIMITER.limit({ key: await sha256(`${route}:${ip}`) });
    return { ok: result?.success === true, configured: true };
  } catch {
    return { ok: false, configured: true };
  }
}

function rateLimitFailure(result, cors) {
  return jsonResponse(
    { error: result.configured ? "Too many requests; try again later" : "Service protection is not configured" },
    result.configured ? 429 : 503,
    cors,
  );
}

async function verifyTurnstile(request, env, action) {
  if (env.ENVIRONMENT === "local" && !env.TURNSTILE_SECRET) return true;
  if (!env.TURNSTILE_SECRET) return false;
  const token = request.headers.get("X-Turnstile-Token") || "";
  if (!token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const allowedHostnames = (env.TURNSTILE_HOSTNAMES || env.CUSTOMER_HOSTS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    return result?.success === true
      && result.action === action
      && typeof result.hostname === "string"
      && allowedHostnames.includes(result.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function readJson(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return null;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function dateInKualaLumpur(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addLocalDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateInKualaLumpur(date);
}

function isValidDate(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return false;
  }
  const parsed = new Date(`${dateString}T12:00:00+08:00`);
  return Number.isFinite(parsed.getTime()) && dateInKualaLumpur(parsed) === dateString;
}

function isScheduledSlot(dateString, slot) {
  const weekday = new Date(`${dateString}T12:00:00+08:00`).getUTCDay();
  const evening = ["19:00", "20:00", "21:00"];
  const weekendMorning = ["10:00", "11:00", "12:00"];
  return evening.includes(slot) || ((weekday === 0 || weekday === 6) && weekendMorning.includes(slot));
}

function isPickupSlotAvailable(dateString, slot) {
  if (!isValidDate(dateString) || !isScheduledSlot(dateString, slot)) {
    return false;
  }
  const today = dateInKualaLumpur();
  if (dateString < today || dateString > addLocalDays(today, 6)) {
    return false;
  }
  const pickupAt = Date.parse(`${dateString}T${slot}:00+08:00`);
  return dateString !== today || Date.now() < pickupAt + 45 * 60 * 1000;
}

function readyAtFor(dateString, slot, service, now = Date.now()) {
  const pickupAt = Date.parse(`${dateString}T${slot}:00+08:00`);
  const pickupHour = Number(slot.slice(0, 2));
  const startAt = Math.max(pickupAt, now);
  const hours = service === "express" ? 6 : pickupHour >= 19 ? 15 : 12;
  return new Date(startAt + hours * 60 * 60 * 1000).toISOString();
}

function formatReadyTime(value) {
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function priceInCents(packageSize, service, hangers) {
  const base = packageSize === 10 ? 2999 : 5499;
  const express = packageSize === 10 ? 1000 : 1500;
  return base + (service === "express" ? express : 0) + (hangers ? 0 : 0);
}

const BOOKING_FIELDS = new Set(["name", "phone", "block", "unit", "packageSize", "service", "hangers", "pickupDate", "pickupSlot", "paymentMethod", "termsAccepted", "priceRevision", "expectedTotalCents"]);

function validateBooking(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !BOOKING_FIELDS.has(key))) return null;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const block = typeof input.block === "string" ? input.block : "";
  const unit = typeof input.unit === "string" ? input.unit.trim() : "";
  const packageSize = Number(input.packageSize);
  const service = input.service;
  const paymentMethod = input.paymentMethod;
  const hangers = input.hangers === true;
  const pickupDate = input.pickupDate;
  const pickupSlot = input.pickupSlot;

  if (!name || name.length > 120 || !/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  if (!BLOCKS.has(block) || !/^[A-Z]-\d{1,2}-\d{1,3}$/i.test(unit)) return null;
  const unitPrefix = unit.slice(0, 1).toUpperCase();
  if (!UNIT_PREFIXES[block]?.includes(unitPrefix)) return null;
  if (![10, 18].includes(packageSize) || !["standard", "express"].includes(service)) return null;
  if (!["cash", "qr"].includes(paymentMethod) || input.termsAccepted !== true) return null;
  if (!isValidDate(pickupDate) || !isScheduledSlot(pickupDate, pickupSlot)) return null;
  const priceRevision = input.priceRevision === undefined ? "" : typeof input.priceRevision === "string" && input.priceRevision.length <= 80 ? input.priceRevision : null;
  const expectedTotalCents = input.expectedTotalCents === undefined ? null : Number.isInteger(input.expectedTotalCents) && input.expectedTotalCents >= 0 ? input.expectedTotalCents : null;
  if (priceRevision === null || expectedTotalCents === null && input.expectedTotalCents !== undefined) return null;

  return {
    name,
    phone,
    block,
    unit,
    packageSize,
    service,
    hangers,
    pickupDate,
    pickupSlot,
    paymentMethod,
    priceRevision,
    expectedTotalCents,
    serviceTotalCents: priceInCents(packageSize, service, hangers),
    feeTotalCents: 0,
    totalCents: priceInCents(packageSize, service, hangers),
    readyAt: readyAtFor(pickupDate, pickupSlot, service),
  };
}

function makeTrackingToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeBase64(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function getTokenEncryptionKey(env) {
  if (!env.TRACKING_TOKEN_ENCRYPTION_KEY) return null;
  const raw = decodeBase64(env.TRACKING_TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error("TRACKING_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptTrackingToken(token, env, associatedData) {
  const key = await getTokenEncryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(associatedData) }, key, new TextEncoder().encode(token));
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

async function decryptTrackingToken(value, env, associatedData) {
  const key = await getTokenEncryptionKey(env);
  if (!key || typeof value !== "string") return null;
  const [ivValue, ciphertextValue] = value.split(".");
  if (!ivValue || !ciphertextValue) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(ivValue), additionalData: new TextEncoder().encode(associatedData) },
      key,
      decodeBase64(ciphertextValue),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function customerIdForPhone(phone) {
  return `customer-${phone.replace(/\D/g, "")}`;
}

function bookingForClient(row, operator = false) {
  const booking = {
    id: row.id,
    number: row.booking_number,
    packageSize: row.package_size,
    service: row.service,
    folding: Boolean(row.folding),
    ironing: Boolean(row.ironing),
    hangers: Boolean(row.hangers),
    pickupDate: row.pickup_date,
    pickupSlot: row.pickup_slot,
    serviceTotal: row.service_total_cents / 100,
    feeTotal: row.fee_total_cents / 100,
    total: row.total_cents / 100,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    termsAccepted: Boolean(row.terms_accepted),
    readyAt: row.ready_at,
    readyTime: formatReadyTime(row.ready_at),
    status: STATUS_LABELS[row.status] || row.status,
    cancellationReason: row.cancellation_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (operator) {
    booking.name = row.customer_name;
    booking.phone = row.phone;
    booking.block = row.block;
    booking.unit = row.unit;
    booking.address = `${row.block}, Unit ${row.unit}, Edumetro, USJ 1`;
    booking.revision = row.revision;
  }
  return booking;
}

async function replayIdempotentBooking(env, keyHash, payloadHash, cors) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE idempotency_key_hash = ?").bind(keyHash).first();
  if (!row) return null;
  if (row.request_payload_hash !== payloadHash) {
    return jsonResponse({ error: "This retry key was already used for a different booking" }, 409, cors);
  }
  const trackingToken = await decryptTrackingToken(row.encrypted_tracking_token, env, `${row.id}:${row.booking_number}`);
  if (!trackingToken) {
    console.error(JSON.stringify({ event: "tracking_token_replay_unavailable" }));
    return jsonResponse({ error: "Booking retry could not be recovered" }, 503, cors);
  }
  return jsonResponse({ booking: bookingForClient(row), trackingToken }, 201, cors);
}

async function createBooking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "booking");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  if (!await verifyTurnstile(request, env, "booking")) {
    return jsonResponse({ error: "Verification failed" }, 403, cors);
  }
  const idempotencyKey = request.headers.get("X-Idempotency-Key") || "";
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(idempotencyKey)) {
    return jsonResponse({ error: "A retry key is required" }, 400, cors);
  }
  const input = await readJson(request);
  const booking = validateBooking(input);
  if (!booking) {
    return jsonResponse({ error: "Booking details are invalid or the pickup slot is unavailable" }, 400, cors);
  }
  const payloadHash = await sha256(canonicalize(booking));
  const keyHash = await sha256(idempotencyKey);
  const replay = await replayIdempotentBooking(env, keyHash, payloadHash, cors);
  if (replay) return replay;
  if (env.PUBLIC_BOOKING_ENABLED !== "true") {
    return jsonResponse({ error: "Booking intake is not enabled" }, 503, cors);
  }
  if (!isPickupSlotAvailable(booking.pickupDate, booking.pickupSlot)) {
    return jsonResponse({ error: "The pickup slot is no longer available" }, 409, cors);
  }
  const customerId = customerIdForPhone(booking.phone);
  const existingCustomer = await env.DB.prepare("SELECT penalty_balance_cents FROM customers WHERE id = ?").bind(customerId).first();
  const feeTotalCents = Number(existingCustomer?.penalty_balance_cents) || 0;
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const trackingToken = makeTrackingToken();
  const trackingTokenHash = await sha256(trackingToken);
  const bookingNumber = `LL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const encryptedTrackingToken = await encryptTrackingToken(trackingToken, env, `${id}:${bookingNumber}`);
  if (!encryptedTrackingToken) {
    return jsonResponse({ error: "Booking security is not configured" }, 503, cors);
  }
  const totalCents = booking.serviceTotalCents + feeTotalCents;
  const currentPriceRevision = env.PRICE_REVISION || "launch-v1";
  if (booking.priceRevision && booking.priceRevision !== currentPriceRevision) {
    return jsonResponse({ error: "The price has changed; refresh checkout", code: "quote_changed" }, 409, cors);
  }
  if (booking.expectedTotalCents !== null && booking.expectedTotalCents !== totalCents) {
    return jsonResponse({ error: "The price has changed; refresh checkout", code: "quote_changed" }, 409, cors);
  }
  const statements = [
    env.DB.prepare(`
      INSERT INTO customers (id, phone_e164, penalty_balance_cents, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone_e164) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(customerId, booking.phone, feeTotalCents, createdAt, createdAt),
  ];
  if (feeTotalCents > 0) {
    statements.push(env.DB.prepare("UPDATE customers SET penalty_balance_cents = 0, updated_at = ? WHERE id = ? AND penalty_balance_cents = ? AND penalty_balance_cents > 0").bind(createdAt, customerId, feeTotalCents));
  }
  const bookingStatement = env.DB.prepare(`
    INSERT INTO bookings (
      id, booking_number, tracking_token_hash, encrypted_tracking_token, tracking_token_key_version,
      idempotency_key_hash, request_payload_hash, customer_id, customer_name, phone, block, unit,
      package_size, service, folding, ironing, hangers, pickup_date, pickup_slot,
      service_total_cents, fee_total_cents, total_cents, payment_method, status, ready_at,
      revision, terms_accepted, terms_accepted_at, terms_policy_version, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 1, 1, ?, ?, ?, ?
    WHERE ? = 0 OR changes() = 1
  `).bind(
    id, bookingNumber, trackingTokenHash, encryptedTrackingToken, keyHash, payloadHash, customerId,
    booking.name, booking.phone, booking.block, booking.unit, booking.packageSize, booking.service,
    booking.hangers ? 1 : 0, booking.pickupDate, booking.pickupSlot, booking.serviceTotalCents,
    feeTotalCents, totalCents, booking.paymentMethod, booking.readyAt, createdAt,
    env.TERMS_POLICY_VERSION || "launch-v1", createdAt, createdAt, feeTotalCents
  );
  statements.push(bookingStatement);
  if (feeTotalCents > 0) {
    statements.push(env.DB.prepare(`
      UPDATE penalty_events SET state = 'allocated', allocated_booking_id = ?, updated_at = ?
      WHERE customer_id = ? AND state = 'outstanding' AND changes() = 1
    `).bind(id, createdAt, customerId));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
    SELECT ?, ?, 'status', NULL, 'confirmed', NULL, ?
    WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)
  `).bind(eventId, id, createdAt, id));
  statements.push(env.DB.prepare(`
    INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, to_value, details_json, created_at)
    SELECT ?, ?, ?, 'booking_created', 'confirmed', ?, ?
    WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)
  `).bind(auditId, id, customerId, JSON.stringify({ feeTotalCents }), createdAt, id));
  try {
    const results = await env.DB.batch(statements);
    const bookingResult = results[feeTotalCents > 0 ? 2 : 1];
    if (bookingResult?.meta?.changes !== 1) {
      if (feeTotalCents > 0) return jsonResponse({ error: "The fee balance changed; refresh checkout and try again" }, 409, cors);
      throw new Error("Booking insert did not change a row");
    }
    const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
    return jsonResponse({ booking: bookingForClient(row), trackingToken }, 201, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("bookings.pickup_date, bookings.pickup_slot")) {
      return jsonResponse({ error: "That pickup slot has just been taken" }, 409, cors);
    }
    if (message.includes("bookings.idempotency_key_hash")) {
      const retry = await replayIdempotentBooking(env, keyHash, payloadHash, cors);
      if (retry) return retry;
    }
    console.error(JSON.stringify({ event: "booking_create_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Booking could not be saved" }, 503, cors);
  }
}

async function getPublicConfig(env, cors) {
  return jsonResponse({
    bookingEnabled: env.PUBLIC_BOOKING_ENABLED === "true",
    priceRevision: env.PRICE_REVISION || "launch-v1",
    turnstileSiteKey: typeof env.TURNSTILE_SITEKEY === "string" && env.TURNSTILE_SITEKEY ? env.TURNSTILE_SITEKEY : null,
  }, 200, cors);
}

async function estimateBooking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "estimate");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  if (!await verifyTurnstile(request, env, "estimate")) {
    return jsonResponse({ error: "Verification failed" }, 403, cors);
  }
  const input = await readJson(request);
  const allowedFields = new Set(["phone", "packageSize", "service", "hangers"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowedFields.has(key))) {
    return jsonResponse({ error: "Estimate details are invalid" }, 400, cors);
  }
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const packageSize = Number(input.packageSize);
  const service = input.service;
  const hangers = input.hangers === true;
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || ![10, 18].includes(packageSize) || !["standard", "express"].includes(service)) {
    return jsonResponse({ error: "Estimate details are invalid" }, 400, cors);
  }
  const serviceTotalCents = priceInCents(packageSize, service, hangers);
  const customerId = customerIdForPhone(phone);
  const customer = await env.DB.prepare("SELECT penalty_balance_cents FROM customers WHERE id = ?").bind(customerId).first();
  const feeTotalCents = Number(customer?.penalty_balance_cents) || 0;
  return jsonResponse({
    currency: "MYR",
    revision: env.PRICE_REVISION || "launch-v1",
    lines: [
      { key: "service", label: `${packageSize}-piece ${SERVICE_LABELS[service]}`, amount: serviceTotalCents / 100 },
      ...(feeTotalCents > 0 ? [{ key: "penalty", label: "Outstanding service fee", amount: feeTotalCents / 100 }] : []),
    ],
    serviceTotal: serviceTotalCents / 100,
    feeTotal: feeTotalCents / 100,
    total: (serviceTotalCents + feeTotalCents) / 100,
  }, 200, cors);
}

async function getAvailability(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "availability");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  const date = new URL(request.url).searchParams.get("date");
  if (!isValidDate(date) || date < dateInKualaLumpur() || date > addLocalDays(dateInKualaLumpur(), 6)) {
    return jsonResponse({ error: "Date is outside the booking window" }, 400, cors);
  }
  const result = await env.DB.prepare(`
    SELECT pickup_slot FROM bookings WHERE pickup_date = ? AND status <> 'cancelled'
  `).bind(date).all();
  return jsonResponse({ date, bookedSlots: result.results.map((row) => row.pickup_slot) }, 200, cors);
}

async function getTracking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "tracking");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  const input = await readJson(request);
  const number = typeof input?.number === "string" ? input.number.trim().toUpperCase() : "";
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  if (!/^LL-[A-F0-9]{8}$/.test(number) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return jsonResponse({ error: "Request not found" }, 404, cors);
  }
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT booking_number, package_size, service, pickup_date, pickup_slot, service_total_cents,
      fee_total_cents, total_cents, ready_at, status, cancellation_reason, payment_status
    FROM bookings WHERE booking_number = ? AND tracking_token_hash = ?
  `).bind(number, tokenHash).first();
  if (!row) return jsonResponse({ error: "Request not found" }, 404, cors);
  const customerCanChange = ["confirmed", "pickup_on_the_way"].includes(row.status);
  const cancellationLate = customerCanChange && customerCancellationIsLate(row);
  return jsonResponse({
    number: row.booking_number,
    packageSize: row.package_size,
    service: row.service,
    pickupDate: row.pickup_date,
    pickupSlot: row.pickup_slot,
    serviceTotal: row.service_total_cents / 100,
    feeTotal: row.fee_total_cents / 100,
    total: row.total_cents / 100,
    readyAt: row.ready_at,
    readyTime: formatReadyTime(row.ready_at),
    status: STATUS_LABELS[row.status] || row.status,
    cancellationReason: row.cancellation_reason || null,
    canCancel: customerCanChange,
    canReschedule: customerCanChange && !cancellationLate,
    canEdit: customerCanChange && !cancellationLate && row.payment_status === "unpaid",
    cancellationLate,
  }, 200, cors);
}

async function customerBookingFromRequest(request, env) {
  const input = await readJson(request);
  const number = typeof input?.number === "string" ? input.number.trim().toUpperCase() : "";
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  const phone = typeof input?.phone === "string" ? input.phone.trim() : "";
  if (!/^LL-[A-F0-9]{8}$/.test(number) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare("SELECT * FROM bookings WHERE booking_number = ? AND tracking_token_hash = ? AND phone = ?").bind(number, tokenHash, phone).first();
}

function pickupStartAt(dateString, slot) {
  return Date.parse(`${dateString}T${slot}:00+08:00`);
}

function customerCancellationIsLate(row) {
  return Date.now() >= pickupStartAt(row.pickup_date, row.pickup_slot) - 10 * 60 * 1000;
}

async function cancelCustomerBooking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "cancel");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  if (!await verifyTurnstile(request, env, "cancel")) {
    return jsonResponse({ error: "Verification failed" }, 403, cors);
  }
  const current = await customerBookingFromRequest(request, env);
  if (!current || ["cancelled", "delivered", "laundry_picked_up", "processing", "ready"].includes(current.status)) {
    return jsonResponse({ error: "Request not found" }, 404, cors);
  }
  const late = customerCancellationIsLate(current);
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const penaltyId = crypto.randomUUID();
  const releaseAmount = Number(current.fee_total_cents) || 0;
  const penaltyAmount = late ? 300 : 0;
  const nextRevision = current.revision + 1;
  const statements = [
    env.DB.prepare(`
      UPDATE bookings SET status = 'cancelled', cancellation_reason = ?, cancellation_actor = 'customer',
        cancelled_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND status NOT IN ('cancelled', 'laundry_picked_up', 'processing', 'ready', 'delivered')
    `).bind(late ? "customer_late" : "customer", now, now, current.id, current.revision),
    env.DB.prepare(`
      INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
      SELECT ?, ?, 'status', ?, 'cancelled', NULL, ? WHERE changes() = 1
    `).bind(eventId, current.id, current.status, now),
  ];
  if (releaseAmount > 0 || penaltyAmount > 0) {
    statements.push(env.DB.prepare(`
      UPDATE customers SET penalty_balance_cents = penalty_balance_cents + ? + CASE WHEN EXISTS (
        SELECT 1 FROM penalty_events WHERE allocated_booking_id = ? AND state = 'allocated'
      ) THEN ? ELSE 0 END, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
    `).bind(penaltyAmount, current.id, releaseAmount, now, current.customer_id, eventId, current.id));
  }
  if (releaseAmount > 0) {
    statements.push(env.DB.prepare(`
      UPDATE penalty_events SET state = 'outstanding', allocated_booking_id = NULL, updated_at = ?
      WHERE allocated_booking_id = ? AND state = 'allocated'
        AND EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
    `).bind(now, current.id, eventId, current.id));
  }
  if (penaltyAmount > 0) {
    statements.push(env.DB.prepare(`
      INSERT INTO penalty_events (id, customer_id, source_booking_id, amount_cents, reason, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'late_cancellation', 'outstanding', ?, ?
      WHERE EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
    `).bind(penaltyId, current.customer_id, current.id, penaltyAmount, now, now, eventId, current.id));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, from_value, to_value, details_json, created_at)
    SELECT ?, ?, ?, 'customer_cancelled', ?, 'cancelled', ?, ?
    WHERE EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
      AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
  `).bind(auditId, current.id, current.customer_id, current.status, JSON.stringify({ late, releasedFeeCents: releaseAmount, penaltyCents: penaltyAmount }), now, eventId, current.id, current.id, nextRevision));
  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
      return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    }
    const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(current.id).first();
    return jsonResponse({ booking: bookingForClient(row) }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("penalty_events_one_booking_incident")) {
      return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    }
    console.error(JSON.stringify({ event: "customer_cancel_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Cancellation could not be saved" }, 503, cors);
  }
}

async function rescheduleCustomerBooking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "reschedule");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  if (!await verifyTurnstile(request, env, "reschedule")) {
    return jsonResponse({ error: "Verification failed" }, 403, cors);
  }
  const input = await readJson(request);
  const current = await customerBookingFromInput(input, env);
  if (!current || ["cancelled", "delivered", "laundry_picked_up", "processing", "ready"].includes(current.status)) {
    return jsonResponse({ error: "Request not found" }, 404, cors);
  }
  if (customerCancellationIsLate(current)) return jsonResponse({ error: "Rescheduling is closed for this pickup" }, 409, cors);
  const pickupDate = typeof input?.pickupDate === "string" ? input.pickupDate : "";
  const pickupSlot = typeof input?.pickupSlot === "string" ? input.pickupSlot : "";
  if (!isPickupSlotAvailable(pickupDate, pickupSlot)) return jsonResponse({ error: "The new pickup slot is unavailable" }, 409, cors);
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE bookings SET pickup_date = ?, pickup_slot = ?, ready_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND status NOT IN ('cancelled', 'delivered', 'laundry_picked_up', 'processing', 'ready')
      `).bind(pickupDate, pickupSlot, readyAtFor(pickupDate, pickupSlot, current.service), now, current.id, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, created_at)
        SELECT ?, ?, ?, 'customer_rescheduled', ?, ? WHERE changes() = 1
      `).bind(auditId, current.id, current.customer_id, JSON.stringify({ fromDate: current.pickup_date, fromSlot: current.pickup_slot, toDate: pickupDate, toSlot: pickupSlot }), now),
    ]);
    if (results[0]?.meta?.changes !== 1) return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(current.id).first();
    return jsonResponse({ booking: bookingForClient(row) }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("bookings.pickup_date, bookings.pickup_slot")) return jsonResponse({ error: "That pickup slot has just been taken" }, 409, cors);
    console.error(JSON.stringify({ event: "customer_reschedule_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Rescheduling could not be saved" }, 503, cors);
  }
}

function customerEditView(row, late) {
  const editLate = late === undefined ? customerCancellationIsLate(row) : late;
  return {
    number: row.booking_number,
    name: row.customer_name,
    block: row.block,
    unit: row.unit,
    packageSize: row.package_size,
    service: row.service,
    folding: Boolean(row.folding),
    ironing: Boolean(row.ironing),
    hangers: Boolean(row.hangers),
    paymentMethod: row.payment_method,
    pickupDate: row.pickup_date,
    pickupSlot: row.pickup_slot,
    serviceTotal: row.service_total_cents / 100,
    feeTotal: row.fee_total_cents / 100,
    total: row.total_cents / 100,
    readyAt: row.ready_at,
    readyTime: formatReadyTime(row.ready_at),
    status: STATUS_LABELS[row.status] || row.status,
    canEdit: isPreCollectionStatus(row.status) && row.payment_status === "unpaid" && !editLate,
    editLate,
  };
}

async function editCustomerBooking(request, env, cors) {
  const limit = await enforceRateLimit(request, env, "edit");
  if (!limit.ok) return rateLimitFailure(limit, cors);
  if (!await verifyTurnstile(request, env, "edit")) {
    return jsonResponse({ error: "Verification failed" }, 403, cors);
  }
  const input = await readJson(request);
  const current = await customerBookingFromInput(input, env);
  if (!current) return jsonResponse({ error: "Request not found" }, 404, cors);
  const late = customerCancellationIsLate(current);
  if (input.fields === undefined) {
    return jsonResponse({ booking: customerEditView(current, late) }, 200, cors);
  }
  if (!isPreCollectionStatus(current.status) || current.payment_status !== "unpaid") {
    return jsonResponse({ error: "This booking can no longer be edited" }, 409, cors);
  }
  if (late) return jsonResponse({ error: "Editing is closed for this pickup" }, 409, cors);
  const fields = input.fields;
  const EDITABLE = new Set(["name", "block", "unit", "packageSize", "service", "hangers", "folding", "ironing", "paymentMethod"]);
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).some((key) => !EDITABLE.has(key))) {
    return jsonResponse({ error: "Invalid edit fields" }, 400, cors);
  }
  const merged = {
    name: fields.name === undefined ? current.customer_name : typeof fields.name === "string" ? fields.name.trim() : null,
    block: fields.block === undefined ? current.block : fields.block,
    unit: fields.unit === undefined ? current.unit : typeof fields.unit === "string" ? fields.unit.trim() : null,
    packageSize: fields.packageSize === undefined ? current.package_size : Number(fields.packageSize),
    service: fields.service === undefined ? current.service : fields.service,
    hangers: fields.hangers === undefined ? Boolean(current.hangers) : fields.hangers === true,
    folding: fields.folding === undefined ? Boolean(current.folding) : fields.folding === true,
    ironing: fields.ironing === undefined ? Boolean(current.ironing) : fields.ironing === true,
    paymentMethod: fields.paymentMethod === undefined ? current.payment_method : fields.paymentMethod,
  };
  if (!merged.name || merged.name.length > 120
    || !BLOCKS.has(merged.block) || !merged.unit || !/^[A-Z]-\d{1,2}-\d{1,3}$/i.test(merged.unit)
    || !UNIT_PREFIXES[merged.block]?.includes(merged.unit.slice(0, 1).toUpperCase())
    || ![10, 18].includes(merged.packageSize) || !["standard", "express"].includes(merged.service)
    || !["cash", "qr"].includes(merged.paymentMethod)) {
    return jsonResponse({ error: "Invalid edit fields" }, 400, cors);
  }
  const serviceChanged = merged.packageSize !== current.package_size || merged.service !== current.service || merged.hangers !== Boolean(current.hangers);
  const columns = {
    customer_name: merged.name, block: merged.block, unit: merged.unit,
    package_size: merged.packageSize, service: merged.service,
    hangers: merged.hangers ? 1 : 0, folding: merged.folding ? 1 : 0, ironing: merged.ironing ? 1 : 0,
    payment_method: merged.paymentMethod,
  };
  if (serviceChanged) {
    columns.service_total_cents = priceInCents(merged.packageSize, merged.service, merged.hangers);
    columns.total_cents = columns.service_total_cents + (Number(current.fee_total_cents) || 0);
  }
  if (merged.service !== current.service) {
    columns.ready_at = readyAtFor(current.pickup_date, current.pickup_slot, merged.service);
  }
  const auditLabels = { customer_name: "name", block: "block", unit: "unit", package_size: "packageSize", service: "service", hangers: "hangers", folding: "folding", ironing: "ironing", payment_method: "paymentMethod" };
  const changes = {};
  const changedFields = [];
  const sets = [];
  const binds = [];
  for (const [column, value] of Object.entries(columns)) {
    if (value === current[column] || (typeof value === "number" && value === Number(current[column]))) continue;
    changes[auditLabels[column] || column] = { from: current[column], to: value };
    if (auditLabels[column]) changedFields.push(auditLabels[column]);
    sets.push(`${column} = ?`);
    binds.push(value);
  }
  if (!sets.length) return jsonResponse({ error: "No changes to save" }, 400, cors);
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const nextRevision = current.revision + 1;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE bookings SET ${sets.join(", ")}, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND status NOT IN ('cancelled', 'delivered', 'laundry_picked_up', 'processing', 'ready')
          AND payment_status = 'unpaid'
      `).bind(...binds, now, current.id, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'edit', ?, ?, NULL, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND revision = ?)
      `).bind(eventId, current.id, current.status, changedFields.join(", "), now, current.id, nextRevision),
      env.DB.prepare(`
        INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, created_at)
        SELECT ?, ?, ?, 'customer_booking_edited', ?, ?
        WHERE EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
      `).bind(crypto.randomUUID(), current.id, current.customer_id, JSON.stringify({ changes }), now, eventId, current.id),
    ]);
    if (results[0]?.meta?.changes !== 1) return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(current.id).first();
    return jsonResponse({ booking: customerEditView(row) }, 200, cors);
  } catch (error) {
    console.error(JSON.stringify({ event: "customer_edit_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "The booking update could not be saved" }, 503, cors);
  }
}

async function customerBookingFromInput(input, env) {
  const number = typeof input?.number === "string" ? input.number.trim().toUpperCase() : "";
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  const phone = typeof input?.phone === "string" ? input.phone.trim() : "";
  if (!/^LL-[A-F0-9]{8}$/.test(number) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare("SELECT * FROM bookings WHERE booking_number = ? AND tracking_token_hash = ? AND phone = ?").bind(number, tokenHash, phone).first();
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function verifyOperator(request, env) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1", "ops.localhost"].includes(hostname) && env.LOCAL_OPERATOR_EMAIL && request.headers.get("X-Local-Operator-Email") === env.LOCAL_OPERATOR_EMAIL) {
    return { kind: "valid", email: env.LOCAL_OPERATOR_EMAIL.toLowerCase() };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OPERATOR_ALLOWED_EMAILS) {
    return { kind: "unconfigured" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 8192) return { kind: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3) return { kind: "invalid" };

  let header;
  let payload;
  let teamDomain;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
    teamDomain = new URL(env.ACCESS_TEAM_DOMAIN);
  } catch {
    return { kind: "invalid" };
  }
  if (teamDomain.protocol !== "https:" || teamDomain.pathname !== "/" || header.alg !== "RS256" || !header.kid) {
    return { kind: "invalid" };
  }
  const issuer = teamDomain.origin;
  try {
    const response = await fetch(new URL("/cdn-cgi/access/certs", issuer), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { kind: "unavailable" };
    const certs = await response.json();
    const jwk = certs.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return { kind: "invalid" };
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!validSignature) return { kind: "invalid" };
  } catch {
    return { kind: "unavailable" };
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer || !audiences.includes(env.ACCESS_AUD) || !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) {
    return { kind: "invalid" };
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  const allowlist = env.OPERATOR_ALLOWED_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowlist.includes(email)) return { kind: "forbidden" };
  return { kind: "valid", email };
}

function statusEventRow(row) {
  return {
    status: STATUS_LABELS[row.to_value] || row.to_value,
    at: row.created_at,
    actor: row.actor_id,
  };
}

async function exportOperatorBookings(request, env, cors) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 100);
  const offset = Math.min(Math.max(Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0), 10000);
  const filter = url.searchParams.get("status") || "all";
  const date = url.searchParams.get("date") || "";
  const clauses = {
    all: "1 = 1",
    pending: "status = 'confirmed'",
    active: "status NOT IN ('confirmed', 'delivered', 'cancelled')",
    completed: "status = 'delivered'",
    cancelled: "status = 'cancelled'",
  };
  if (!Object.hasOwn(clauses, filter) || date && !isValidDate(date)) return jsonResponse({ error: "Invalid export filter" }, 400, cors, { operator: true });
  const result = await env.DB.prepare(`
    SELECT booking_number, pickup_date, pickup_slot, status, customer_name, phone, block, unit,
      package_size, service, total_cents, payment_status
    FROM bookings WHERE ${clauses[filter]}${date ? " AND pickup_date = ?" : ""}
    ORDER BY pickup_date, pickup_slot, id LIMIT ? OFFSET ?
  `).bind(...(date ? [date] : []), limit, offset).all();
  return csvResponse(result.results.map((row) => [
    row.booking_number,
    row.pickup_date,
    row.pickup_slot,
    STATUS_LABELS[row.status] || row.status,
    row.customer_name,
    row.phone,
    row.block,
    row.unit,
    row.package_size,
    SERVICE_LABELS[row.service] || row.service,
    (Number(row.total_cents) / 100).toFixed(2),
    row.payment_status,
  ]), cors);
}

async function getOperatorBookings(request, env, cors) {
  const url = new URL(request.url);
  const input = request.method === "POST" ? await readJson(request) : {
    status: url.searchParams.get("status") || "all",
    date: url.searchParams.get("date") || "",
    limit: Number(url.searchParams.get("limit") || 25),
    offset: Number(url.searchParams.get("offset") || 0),
  };
  const clauses = {
    all: "1 = 1",
    pending: "status = 'confirmed'",
    active: "status NOT IN ('confirmed', 'delivered', 'cancelled')",
    completed: "status = 'delivered'",
    cancelled: "status = 'cancelled'",
  };
  const allowed = new Set(["status", "query", "date", "limit", "offset"]);
  const { status = "all", query = "", date = "", limit = 25, offset = 0 } = input || {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))
    || typeof status !== "string" || !Object.hasOwn(clauses, status) || typeof query !== "string" || query.length > 200
    || typeof date !== "string" || date && !isValidDate(date)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
    return jsonResponse({ error: "Invalid search or pagination" }, 400, cors, { operator: true });
  }
  const where = [clauses[status]];
  const params = [];
  if (date) {
    where.push("pickup_date = ?");
    params.push(date);
  }
  if (query.trim()) {
    where.push("instr(lower(coalesce(booking_number, '') || ' ' || coalesce(customer_name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(block, '') || ' ' || coalesce(unit, '')), lower(?)) > 0");
    params.push(query.trim());
  }
  const filter = where.join(" AND ");
  const [result, count, summary] = await Promise.all([
    env.DB.prepare(`
      SELECT id, booking_number, customer_name, phone, block, unit, package_size, service,
        folding, ironing, hangers, pickup_date, pickup_slot, service_total_cents, fee_total_cents,
        total_cents, payment_method, payment_status, status, cancellation_reason, revision,
        ready_at, terms_accepted, created_at, updated_at
      FROM bookings WHERE ${filter}
      ORDER BY CASE WHEN status IN ('delivered', 'cancelled') THEN 1 ELSE 0 END,
        CASE WHEN status NOT IN ('delivered', 'cancelled') THEN pickup_date || pickup_slot END ASC,
        pickup_date DESC, pickup_slot DESC, id ASC LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM bookings WHERE ${filter}`).bind(...params).first(),
    env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS pending,
        COUNT(CASE WHEN status NOT IN ('confirmed', 'delivered', 'cancelled') THEN 1 END) AS active,
        COUNT(CASE WHEN payment_status = 'unpaid' AND status <> 'cancelled' THEN 1 END) AS unpaid,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' AND status <> 'cancelled' THEN total_cents ELSE 0 END), 0) AS collected_cents
      FROM bookings
    `).first(),
  ]);
  const total = Number(count?.total) || 0;
  return jsonResponse({
    bookings: result.results.map((row) => bookingForClient(row, true)),
    summary: {
      pending: Number(summary?.pending) || 0,
      active: Number(summary?.active) || 0,
      unpaid: Number(summary?.unpaid) || 0,
      collected: Number(summary?.collected_cents) / 100 || 0,
    },
    page: { offset, limit, total, hasMore: offset + result.results.length < total && offset + limit < total },
  }, 200, cors, { operator: true });
}

async function getOperatorBooking(env, id, cors) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!row) return jsonResponse({ error: "Booking not found" }, 404, cors);
  const [events, notes, penalties] = await Promise.all([
    env.DB.prepare(`
      SELECT event_type, from_value, to_value, actor_id, created_at
      FROM booking_events WHERE booking_id = ? ORDER BY created_at
    `).bind(id).all(),
    env.DB.prepare(`
      SELECT id, note, actor_id, created_at
      FROM operator_notes WHERE booking_id = ? ORDER BY created_at DESC LIMIT 50
    `).bind(id).all(),
    env.DB.prepare(`
      SELECT id, amount_cents, reason, state, source_booking_id, allocated_booking_id, actor_id, note, created_at, updated_at
      FROM penalty_events
      WHERE customer_id = ? OR source_booking_id = ? OR allocated_booking_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).bind(row.customer_id, id, id).all(),
  ]);
  const booking = bookingForClient(row, true);
  booking.statusHistory = events.results.filter((event) => event.event_type === "status").map(statusEventRow);
  booking.events = events.results.map((event) => ({
    type: event.event_type,
    from: event.from_value,
    to: event.event_type === "status" ? STATUS_LABELS[event.to_value] || event.to_value : event.to_value,
    actor: event.actor_id,
    at: event.created_at,
  }));
  booking.notes = notes.results.map((note) => ({
    id: note.id,
    note: note.note,
    actor: note.actor_id,
    at: note.created_at,
  }));
  booking.penalties = penalties.results.map((penalty) => ({
    id: penalty.id,
    amount: penalty.amount_cents / 100,
    reason: penalty.reason,
    state: penalty.state,
    sourceBookingId: penalty.source_booking_id,
    allocatedBookingId: penalty.allocated_booking_id,
    actor: penalty.actor_id,
    note: penalty.note,
    createdAt: penalty.created_at,
    updatedAt: penalty.updated_at,
  }));
  return jsonResponse({ booking }, 200, cors);
}

function operatorReason(input, required = false) {
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 500) return null;
  if (required && !reason) return null;
  return reason;
}

function isPreCollectionStatus(status) {
  return status === "confirmed" || status === "pickup_on_the_way";
}

function isPickupOpportunityElapsed(row) {
  return Date.now() >= pickupStartAt(row.pickup_date, row.pickup_slot) + 45 * 60 * 1000;
}

function operatorAuditStatement(env, { id, current, eventType, fromValue, toValue, details, actor, now, status, revision, guardChanges = false }) {
  return env.DB.prepare(`
    INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, from_value, to_value, details_json, actor_id, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = ? AND revision = ?)${guardChanges ? " AND changes() = 1" : ""}
  `).bind(
    crypto.randomUUID(), id, current.customer_id, eventType, fromValue, toValue,
    JSON.stringify(details || {}), actor, now, id, status, revision,
  );
}

function releaseAllocatedFeeStatements(env, current, now, nextRevision) {
  const releaseAmount = Number(current.fee_total_cents) || 0;
  if (!releaseAmount) return [];
  return [
    env.DB.prepare(`
      UPDATE penalty_events SET state = 'outstanding', allocated_booking_id = NULL, updated_at = ?
      WHERE allocated_booking_id = ? AND state = 'allocated' AND changes() = 1
        AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
    `).bind(now, current.id, current.id, nextRevision),
    env.DB.prepare(`
      UPDATE customers SET penalty_balance_cents = penalty_balance_cents + CASE WHEN changes() > 0 THEN ? ELSE 0 END, updated_at = ?
      WHERE id = ? AND changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
    `).bind(releaseAmount, now, current.customer_id, current.id, nextRevision),
  ];
}

async function updateOperatorBooking(request, env, id, actor, cors) {
  const input = await readJson(request);
  const actions = ["advance", "cancel", "no_show", "paid", "reopen", "edit"];
  if (!input || !actions.includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    return jsonResponse({ error: "Invalid update" }, 400, cors);
  }
  const current = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!current) return jsonResponse({ error: "Booking not found" }, 404, cors);
  if (input.revision !== current.revision) {
    return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
  }

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const reasonRequired = ["cancel", "no_show", "reopen", "edit"].includes(input.action);
  const reason = operatorReason(input, reasonRequired);
  if (reason === null) return jsonResponse({ error: "A reason is required and must be 500 characters or fewer" }, 400, cors);

  let statements;
  const nextRevision = current.revision + 1;

  if (input.action === "advance") {
    const index = STATUS_CODES.indexOf(current.status);
    const next = index >= 0 ? STATUS_CODES[index + 1] : null;
    if (!next) return jsonResponse({ error: "Booking cannot advance further" }, 409, cors);
    if (next === "delivered" && current.payment_status !== "paid") {
      return jsonResponse({ error: "Payment must be recorded before delivery" }, 409, cors);
    }
    statements = [
      env.DB.prepare("UPDATE bookings SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = ? AND revision = ?").bind(next, now, id, current.status, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'status', ?, ?, ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = ? AND revision = ?)
      `).bind(eventId, id, current.status, next, actor, now, id, next, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_status_changed", fromValue: current.status, toValue: next, details: { reason }, actor, now, status: next, revision: nextRevision, guardChanges: true }),
    ];
  } else if (input.action === "cancel") {
    if (!isPreCollectionStatus(current.status) || current.payment_status === "paid") {
      return jsonResponse({ error: "Booking can no longer be cancelled" }, 409, cors);
    }
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET status = 'cancelled', cancellation_reason = 'operator', cancellation_actor = ?,
          cancelled_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = ? AND revision = ?
      `).bind(actor, now, now, id, current.status, current.revision),
      ...releaseAllocatedFeeStatements(env, current, now, nextRevision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'status', ?, 'cancelled', ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
      `).bind(eventId, id, current.status, actor, now, id, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_cancelled", fromValue: current.status, toValue: "cancelled", details: { reason, releasedFeeCents: Number(current.fee_total_cents) || 0 }, actor, now, status: "cancelled", revision: nextRevision, guardChanges: true }),
    ];
  } else if (input.action === "no_show") {
    if (!isPreCollectionStatus(current.status) || current.payment_status === "paid") {
      return jsonResponse({ error: "This booking is not eligible for a no-show decision" }, 409, cors);
    }
    if (!isPickupOpportunityElapsed(current)) {
      return jsonResponse({ error: "The pickup opportunity has not elapsed" }, 409, cors);
    }
    const releaseAmount = Number(current.fee_total_cents) || 0;
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET status = 'cancelled', cancellation_reason = 'no_show', cancellation_actor = ?,
          cancelled_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = ? AND revision = ?
      `).bind(actor, now, now, id, current.status, current.revision),
      ...releaseAllocatedFeeStatements(env, current, now, nextRevision),
      env.DB.prepare(`
        UPDATE customers SET penalty_balance_cents = penalty_balance_cents + 300, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
      `).bind(now, current.customer_id, id, nextRevision),
      env.DB.prepare(`
        INSERT INTO penalty_events (id, customer_id, source_booking_id, amount_cents, reason, state, actor_id, created_at, updated_at)
        SELECT ?, ?, ?, 300, 'no_show', 'outstanding', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
      `).bind(crypto.randomUUID(), current.customer_id, id, actor, now, now, id, nextRevision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'status', ?, 'cancelled', ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'cancelled' AND revision = ?)
      `).bind(eventId, id, current.status, actor, now, id, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_no_show", fromValue: current.status, toValue: "cancelled", details: { reason, releasedFeeCents: releaseAmount, penaltyCents: 300 }, actor, now, status: "cancelled", revision: nextRevision, guardChanges: true }),
    ];
  } else if (input.action === "reopen") {
    if (current.status !== "cancelled" || current.payment_status === "paid") {
      return jsonResponse({ error: "Only unpaid cancelled bookings can be reopened" }, 409, cors);
    }
    const pickupDate = typeof input.pickupDate === "string" && input.pickupDate ? input.pickupDate : current.pickup_date;
    const pickupSlot = typeof input.pickupSlot === "string" && input.pickupSlot ? input.pickupSlot : current.pickup_slot;
    if (!isPickupSlotAvailable(pickupDate, pickupSlot)) {
      return jsonResponse({ error: "The pickup slot is no longer available" }, 409, cors);
    }
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET status = 'confirmed', cancellation_reason = NULL, cancellation_actor = NULL,
          cancelled_at = NULL, pickup_date = ?, pickup_slot = ?, ready_at = ?, fee_total_cents = 0,
          total_cents = service_total_cents, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'cancelled' AND payment_status = 'unpaid' AND revision = ?
      `).bind(pickupDate, pickupSlot, readyAtFor(pickupDate, pickupSlot, current.service), now, id, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'status', 'cancelled', 'confirmed', ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'confirmed' AND revision = ?)
      `).bind(eventId, id, actor, now, id, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_reopened", fromValue: "cancelled", toValue: "confirmed", details: { reason, fromDate: current.pickup_date, fromSlot: current.pickup_slot, pickupDate, pickupSlot, clearedFeeCents: Number(current.fee_total_cents) || 0 }, actor, now, status: "confirmed", revision: nextRevision, guardChanges: true }),
    ];
  } else if (input.action === "edit") {
    if (!isPreCollectionStatus(current.status) || current.payment_status !== "unpaid") {
      return jsonResponse({ error: "This booking can no longer be edited" }, 409, cors);
    }
    const fields = input.fields;
    const EDITABLE = new Set(["name", "phone", "block", "unit", "packageSize", "service", "hangers", "folding", "ironing", "paymentMethod", "pickupDate", "pickupSlot"]);
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).some((key) => !EDITABLE.has(key))) {
      return jsonResponse({ error: "Invalid edit fields" }, 400, cors);
    }
    const merged = {
      name: fields.name === undefined ? current.customer_name : typeof fields.name === "string" ? fields.name.trim() : null,
      phone: fields.phone === undefined ? current.phone : typeof fields.phone === "string" ? fields.phone.trim() : null,
      block: fields.block === undefined ? current.block : fields.block,
      unit: fields.unit === undefined ? current.unit : typeof fields.unit === "string" ? fields.unit.trim() : null,
      packageSize: fields.packageSize === undefined ? current.package_size : Number(fields.packageSize),
      service: fields.service === undefined ? current.service : fields.service,
      hangers: fields.hangers === undefined ? Boolean(current.hangers) : fields.hangers === true,
      folding: fields.folding === undefined ? Boolean(current.folding) : fields.folding === true,
      ironing: fields.ironing === undefined ? Boolean(current.ironing) : fields.ironing === true,
      paymentMethod: fields.paymentMethod === undefined ? current.payment_method : fields.paymentMethod,
      pickupDate: fields.pickupDate === undefined ? current.pickup_date : fields.pickupDate,
      pickupSlot: fields.pickupSlot === undefined ? current.pickup_slot : fields.pickupSlot,
    };
    const slotChanged = merged.pickupDate !== current.pickup_date || merged.pickupSlot !== current.pickup_slot;
    if (!merged.name || merged.name.length > 120
      || !merged.phone || !/^\+[1-9]\d{6,14}$/.test(merged.phone)
      || !BLOCKS.has(merged.block) || !merged.unit || !/^[A-Z]-\d{1,2}-\d{1,3}$/i.test(merged.unit)
      || !UNIT_PREFIXES[merged.block]?.includes(merged.unit.slice(0, 1).toUpperCase())
      || ![10, 18].includes(merged.packageSize) || !["standard", "express"].includes(merged.service)
      || !["cash", "qr"].includes(merged.paymentMethod)
      || (slotChanged && (!isValidDate(merged.pickupDate) || !isScheduledSlot(merged.pickupDate, merged.pickupSlot)))) {
      return jsonResponse({ error: "Invalid edit fields" }, 400, cors);
    }
    if (slotChanged && !isPickupSlotAvailable(merged.pickupDate, merged.pickupSlot)) {
      return jsonResponse({ error: "The pickup slot is no longer available" }, 409, cors);
    }
    const serviceChanged = merged.packageSize !== current.package_size || merged.service !== current.service || merged.hangers !== Boolean(current.hangers);
    const serviceTotalCents = serviceChanged ? priceInCents(merged.packageSize, merged.service, merged.hangers) : current.service_total_cents;
    const columns = {
      customer_name: merged.name, phone: merged.phone, block: merged.block, unit: merged.unit,
      package_size: merged.packageSize, service: merged.service,
      hangers: merged.hangers ? 1 : 0, folding: merged.folding ? 1 : 0, ironing: merged.ironing ? 1 : 0,
      payment_method: merged.paymentMethod, pickup_date: merged.pickupDate, pickup_slot: merged.pickupSlot,
    };
    if (serviceChanged) {
      columns.service_total_cents = serviceTotalCents;
      columns.total_cents = serviceTotalCents + (Number(current.fee_total_cents) || 0);
    }
    if (slotChanged || merged.service !== current.service) {
      columns.ready_at = readyAtFor(merged.pickupDate, merged.pickupSlot, merged.service);
    }
    const auditLabels = { customer_name: "name", phone: "phone", block: "block", unit: "unit", package_size: "packageSize", service: "service", hangers: "hangers", folding: "folding", ironing: "ironing", payment_method: "paymentMethod", pickup_date: "pickupDate", pickup_slot: "pickupSlot" };
    const changes = {};
    const changedFields = [];
    const sets = [];
    const binds = [];
    for (const [column, value] of Object.entries(columns)) {
      if (value === current[column] || (typeof value === "number" && value === Number(current[column]))) continue;
      changes[auditLabels[column] || column] = { from: current[column], to: value };
      if (auditLabels[column]) changedFields.push(auditLabels[column]);
      sets.push(`${column} = ?`);
      binds.push(value);
    }
    if (!sets.length) return jsonResponse({ error: "No changes to save" }, 400, cors);
    statements = [
      env.DB.prepare(`UPDATE bookings SET ${sets.join(", ")}, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = ? AND payment_status = 'unpaid' AND revision = ?`)
        .bind(...binds, now, id, current.status, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'edit', ?, ?, ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND revision = ?)
      `).bind(eventId, id, current.status, changedFields.join(", "), actor, now, id, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_booking_edited", fromValue: current.status, toValue: current.status, details: { changes, reason }, actor, now, status: current.status, revision: nextRevision, guardChanges: true }),
    ];
  } else {
    if (current.payment_status !== "unpaid" || current.status === "cancelled") {
      return jsonResponse({ error: "Payment cannot be updated" }, 409, cors);
    }
    statements = [
      env.DB.prepare("UPDATE bookings SET payment_status = 'paid', updated_at = ?, revision = revision + 1 WHERE id = ? AND payment_status = 'unpaid' AND status <> 'cancelled' AND revision = ?").bind(now, id, current.revision),
      env.DB.prepare(`
        INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
        SELECT ?, ?, 'payment', 'unpaid', 'paid', ?, ?
        WHERE changes() = 1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND payment_status = 'paid' AND revision = ?)
      `).bind(eventId, id, actor, now, id, nextRevision),
      operatorAuditStatement(env, { id, current, eventType: "operator_payment_recorded", fromValue: "unpaid", toValue: "paid", details: { settledFeeCents: Number(current.fee_total_cents) || 0 }, actor, now, status: current.status, revision: nextRevision, guardChanges: true }),
      env.DB.prepare(`
        UPDATE penalty_events SET state = 'settled', updated_at = ?
        WHERE allocated_booking_id = ? AND state = 'allocated'
          AND EXISTS (SELECT 1 FROM booking_events WHERE id = ? AND booking_id = ?)
      `).bind(now, id, eventId, id),
    ];
  }

  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta?.changes !== 1) {
      return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    }
    return getOperatorBooking(env, id, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("bookings.pickup_date, bookings.pickup_slot")) {
      return jsonResponse({ error: "That pickup slot has just been taken" }, 409, cors);
    }
    console.error(JSON.stringify({ event: "operator_update_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Update could not be saved" }, 503, cors);
  }
}

async function addOperatorNote(request, env, id, actor, cors) {
  const input = await readJson(request);
  const note = typeof input?.note === "string" ? input.note.trim() : "";
  if (!note || note.length > 2000 || Object.keys(input || {}).some((key) => key !== "note")) {
    return jsonResponse({ error: "A note between 1 and 2000 characters is required" }, 400, cors);
  }
  const current = await env.DB.prepare("SELECT id, customer_id FROM bookings WHERE id = ?").bind(id).first();
  if (!current) return jsonResponse({ error: "Booking not found" }, 404, cors);
  const now = new Date().toISOString();
  const noteId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(`
      INSERT INTO operator_notes (id, booking_id, note, actor_id, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)
    `).bind(noteId, id, note, actor, now, id),
    env.DB.prepare(`
      INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, actor_id, created_at)
      SELECT ?, ?, ?, 'operator_note_added', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM operator_notes WHERE id = ? AND booking_id = ?)
    `).bind(crypto.randomUUID(), id, current.customer_id, JSON.stringify({ noteId }), actor, now, noteId, id),
  ];
  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta?.changes !== 1) return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    return getOperatorBooking(env, id, cors);
  } catch (error) {
    console.error(JSON.stringify({ event: "operator_note_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Note could not be saved" }, 503, cors);
  }
}

async function waiveOperatorPenalty(request, env, penaltyId, actor, cors) {
  const input = await readJson(request);
  const reason = operatorReason(input, true);
  if (reason === null || Object.keys(input || {}).some((key) => key !== "reason")) {
    return jsonResponse({ error: "A waiver reason is required and must be 500 characters or fewer" }, 400, cors);
  }
  const penalty = await env.DB.prepare(`
    SELECT p.*, b.payment_status AS booking_payment_status, b.status AS booking_status,
      b.revision AS booking_revision, b.fee_total_cents AS booking_fee_total_cents
    FROM penalty_events p
    LEFT JOIN bookings b ON b.id = p.allocated_booking_id
    WHERE p.id = ?
  `).bind(penaltyId).first();
  if (!penalty) return jsonResponse({ error: "Penalty not found" }, 404, cors);
  if (penalty.state === "settled" || penalty.state === "waived") {
    return jsonResponse({ error: "This penalty can no longer be waived" }, 409, cors);
  }
  if (penalty.state === "allocated" && (penalty.booking_payment_status === "paid" || !penalty.allocated_booking_id)) {
    return jsonResponse({ error: "A paid or invalid booking fee requires a manual exception" }, 409, cors);
  }
  const now = new Date().toISOString();
  const amount = Number(penalty.amount_cents) || 0;
  const auditId = crypto.randomUUID();
  let statements;
  if (penalty.state === "outstanding") {
    statements = [
      env.DB.prepare(`
        UPDATE customers SET penalty_balance_cents = penalty_balance_cents - ?, updated_at = ?
        WHERE id = ? AND penalty_balance_cents >= ?
          AND EXISTS (SELECT 1 FROM penalty_events WHERE id = ? AND state = 'outstanding')
      `).bind(amount, now, penalty.customer_id, amount, penaltyId),
      env.DB.prepare(`
        UPDATE penalty_events SET state = 'waived', actor_id = ?, note = ?, updated_at = ?
        WHERE id = ? AND state = 'outstanding' AND changes() = 1
      `).bind(actor, reason, now, penaltyId),
      env.DB.prepare(`
        INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, actor_id, created_at)
        SELECT ?, ?, ?, 'operator_fee_waived', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM penalty_events WHERE id = ? AND state = 'waived')
      `).bind(auditId, penalty.source_booking_id, penalty.customer_id, JSON.stringify({ penaltyId, amountCents: amount, reason }), actor, now, penaltyId),
    ];
  } else {
    const bookingRevision = Number(penalty.booking_revision);
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET fee_total_cents = MAX(0, fee_total_cents - ?),
          total_cents = MAX(0, total_cents - ?), updated_at = ?, revision = revision + 1
        WHERE id = ? AND payment_status = 'unpaid' AND status <> 'cancelled' AND revision = ?
          AND EXISTS (SELECT 1 FROM penalty_events WHERE id = ? AND state = 'allocated' AND allocated_booking_id = ?)
      `).bind(amount, amount, now, penalty.allocated_booking_id, bookingRevision, penaltyId, penalty.allocated_booking_id),
      env.DB.prepare(`
        UPDATE penalty_events SET state = 'waived', allocated_booking_id = NULL, actor_id = ?, note = ?, updated_at = ?
        WHERE id = ? AND state = 'allocated' AND allocated_booking_id = ? AND changes() = 1
          AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND revision = ? AND payment_status = 'unpaid')
      `).bind(actor, reason, now, penaltyId, penalty.allocated_booking_id, penalty.allocated_booking_id, bookingRevision + 1),
      env.DB.prepare(`
        INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, actor_id, created_at)
        SELECT ?, ?, ?, 'operator_fee_waived', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM penalty_events WHERE id = ? AND state = 'waived')
      `).bind(auditId, penalty.allocated_booking_id, penalty.customer_id, JSON.stringify({ penaltyId, amountCents: amount, reason }), actor, now, penaltyId),
    ];
  }
  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta?.changes !== 1 || (penalty.state === "outstanding" && results[1]?.meta?.changes !== 1) || (penalty.state === "allocated" && results[1]?.meta?.changes !== 1)) {
      return jsonResponse({ error: "Penalty changed; refresh and try again" }, 409, cors);
    }
    if (penalty.allocated_booking_id) return getOperatorBooking(env, penalty.allocated_booking_id, cors);
    return jsonResponse({ waived: true }, 200, cors);
  } catch (error) {
    console.error(JSON.stringify({ event: "operator_fee_waiver_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Penalty waiver could not be saved" }, 503, cors);
  }
}

function customerTrackingOrigin(env) {
  const configured = typeof env.CUSTOMER_ORIGIN === "string" ? env.CUSTOMER_ORIGIN.trim().replace(/\/+$/, "") : "";
  if (/^https?:\/\/[^/]+$/i.test(configured)) return configured;
  const host = (env.CUSTOMER_HOSTS || "lazylaundry.me").split(",").map((value) => value.trim()).find(Boolean) || "lazylaundry.me";
  return env.ENVIRONMENT === "local" ? "http://localhost:8787" : `https://${host}`;
}

async function operatorTrackingTokenAction(request, env, id, actor, action, cors) {
  const current = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!current) return jsonResponse({ error: "Booking not found" }, 404, cors);
  let input = {};
  if (action !== "share") {
    input = await readJson(request);
    const reason = operatorReason(input, true);
    if (reason === null || Object.keys(input || {}).some((key) => key !== "reason")) {
      return jsonResponse({ error: "A reason is required and must be 500 characters or fewer" }, 400, cors);
    }
  }

  if (action === "share" && !current.encrypted_tracking_token) {
    return jsonResponse({ error: "The tracking link has been revoked; rotate it before sharing" }, 409, cors);
  }
  const now = new Date().toISOString();
  let token = null;
  let statements;
  let nextRevision = current.revision;
  if (action === "share") {
    token = await decryptTrackingToken(current.encrypted_tracking_token, env, `${current.id}:${current.booking_number}`);
    if (!token) return jsonResponse({ error: "The tracking link could not be recovered" }, 503, cors);
    statements = [
      env.DB.prepare(`
        INSERT INTO booking_audit_events (id, booking_id, customer_id, event_type, details_json, actor_id, created_at)
        SELECT ?, ?, ?, 'operator_tracking_shared', '{}', ?, ?
        WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)
      `).bind(crypto.randomUUID(), id, current.customer_id, actor, now, id),
    ];
  } else if (action === "rotate") {
    token = makeTrackingToken();
    const tokenHash = await sha256(token);
    const encryptedToken = await encryptTrackingToken(token, env, `${current.id}:${current.booking_number}`);
    if (!encryptedToken) return jsonResponse({ error: "Tracking security is not configured" }, 503, cors);
    nextRevision += 1;
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET tracking_token_hash = ?, encrypted_tracking_token = ?, tracking_token_key_version = 'v1',
          updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).bind(tokenHash, encryptedToken, now, id, current.revision),
      operatorAuditStatement(env, { id, current, eventType: "operator_tracking_rotated", fromValue: null, toValue: null, details: { reason: input.reason }, actor, now, status: current.status, revision: nextRevision, guardChanges: true }),
    ];
  } else {
    const revokedHash = await sha256(makeTrackingToken());
    nextRevision += 1;
    statements = [
      env.DB.prepare(`
        UPDATE bookings SET tracking_token_hash = ?, encrypted_tracking_token = NULL, tracking_token_key_version = NULL,
          updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).bind(revokedHash, now, id, current.revision),
      operatorAuditStatement(env, { id, current, eventType: "operator_tracking_revoked", fromValue: null, toValue: null, details: { reason: input.reason }, actor, now, status: current.status, revision: nextRevision, guardChanges: true }),
    ];
  }

  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta?.changes !== 1 || (action !== "share" && results[1]?.meta?.changes !== 1)) {
      return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    }
    if (action === "revoke") return jsonResponse({ revoked: true }, 200, cors);
    return jsonResponse({ trackingLink: `${customerTrackingOrigin(env)}/track#number=${encodeURIComponent(current.booking_number)}&token=${encodeURIComponent(token)}` }, 200, cors);
  } catch (error) {
    console.error(JSON.stringify({ event: "operator_tracking_action_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Tracking link action could not be saved" }, 503, cors);
  }
}

async function requireOperator(request, env, cors) {
  const auth = await verifyOperator(request, env);
  if (auth.kind === "unconfigured") {
    return { response: jsonResponse({ error: "Operator access is not configured" }, 503, cors) };
  }
  if (auth.kind === "unavailable") {
    return { response: jsonResponse({ error: "Operator access could not be verified" }, 503, cors) };
  }
  if (auth.kind === "forbidden") {
    return { response: jsonResponse({ error: "Forbidden" }, 403, cors) };
  }
  if (auth.kind !== "valid") {
    return { response: jsonResponse({ error: "Unauthorized" }, 401, cors) };
  }
  return { email: auth.email };
}

export { canonicalize, csvCell, customerCancellationIsLate, isPickupSlotAvailable, isScheduledSlot, isValidDate, makeTrackingToken, priceInCents };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const role = hostRole(request, env);
    if (!role) return jsonResponse({ error: "Not found" }, 404);
    const cors = getCorsHeaders(request, env);
    if (cors === null) return jsonResponse({ error: "Origin is not allowed" }, 403, {}, { operator: role === "operator" });
    if (request.method === "OPTIONS") {
      return cors ? new Response(null, { status: 204, headers: { ...securityHeaders({ api: true, operator: role === "operator" }), ...cors } }) : jsonResponse({ error: "Origin is not allowed" }, 403, {}, { operator: role === "operator" });
    }
    if (!url.pathname.startsWith("/api/")) {
      if (role === "operator" && env.ENVIRONMENT !== "local") {
        const operator = await requireOperator(request, env, cors || {});
        if (operator.response) return operator.response;
      }
      return serveAsset(request, env, role);
    }
    const mutationError = mutationRequestError(request);
    if (mutationError) return jsonResponse({ error: mutationError }, 403, cors || {}, { operator: role === "operator" });
    if (url.pathname.startsWith("/api/operator/") && role !== "operator") {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!url.pathname.startsWith("/api/operator/") && role !== "customer") {
      return jsonResponse({ error: "Not found" }, 404, {}, { operator: true });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ready").first();
        if (result?.ready !== 1) throw new Error("D1 health check failed");
        return jsonResponse({ status: "ok" }, 200, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "d1_health_check_failed" }));
        return jsonResponse({ error: "Service unavailable" }, 503, cors || {});
      }
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return getPublicConfig(env, cors || {});
    }

    if (request.method === "GET" && url.pathname === "/api/availability") {
      try {
        return await getAvailability(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "availability_lookup_failed" }));
        return jsonResponse({ error: "Availability could not be loaded" }, 503, cors || {});
      }
    }

    if (request.method === "POST" && url.pathname === "/api/estimate") {
      try {
        return await estimateBooking(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "estimate_failed" }));
        return jsonResponse({ error: "Estimate could not be loaded" }, 503, cors || {});
      }
    }

    if (request.method === "POST" && url.pathname === "/api/bookings") {
      try {
        return await createBooking(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "booking_create_failed", errorType: "unexpected" }));
        return jsonResponse({ error: "Booking could not be saved" }, 503, cors || {});
      }
    }

    if (request.method === "POST" && url.pathname === "/api/track") {
      try {
        return await getTracking(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "tracking_lookup_failed" }));
        return jsonResponse({ error: "Tracking could not be loaded" }, 503, cors || {});
      }
    }

    const customerMutationMatch = url.pathname.match(/^\/api\/bookings\/(LL-[A-F0-9]{8})\/(cancel|reschedule|edit)$/i);
    if (customerMutationMatch && request.method === "POST") {
      try {
        const mutation = customerMutationMatch[2].toLowerCase();
        return mutation === "cancel"
          ? await cancelCustomerBooking(request, env, cors || {})
          : mutation === "reschedule"
            ? await rescheduleCustomerBooking(request, env, cors || {})
            : await editCustomerBooking(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "customer_booking_mutation_failed" }));
        return jsonResponse({ error: "Booking update could not be saved" }, 503, cors || {});
      }
    }

    if (url.pathname.startsWith("/api/operator/")) {
      const operator = await requireOperator(request, env, cors || {});
      if (operator.response) return operator.response;
      try {
        if (request.method === "GET" && url.pathname === "/api/operator/export") {
          const limit = await enforceRateLimit(request, env, "operator-export");
          if (!limit.ok) return rateLimitFailure(limit, cors || {});
          return await exportOperatorBookings(request, env, cors || {});
        }
        if (request.method === "GET" && url.pathname === "/api/operator/bookings" || request.method === "POST" && url.pathname === "/api/operator/bookings/search") {
          return await getOperatorBookings(request, env, cors || {});
        }
        const noteMatch = url.pathname.match(/^\/api\/operator\/bookings\/([0-9a-f-]{36})\/notes$/i);
        if (noteMatch && request.method === "POST") {
          return await addOperatorNote(request, env, noteMatch[1], operator.email, cors || {});
        }
        const trackingMatch = url.pathname.match(/^\/api\/operator\/bookings\/([0-9a-f-]{36})\/(share|rotate|revoke)$/i);
        if (trackingMatch && request.method === "POST") {
          return await operatorTrackingTokenAction(request, env, trackingMatch[1], operator.email, trackingMatch[2].toLowerCase(), cors || {});
        }
        const penaltyMatch = url.pathname.match(/^\/api\/operator\/penalties\/([0-9a-f-]{36})\/waive$/i);
        if (penaltyMatch && request.method === "POST") {
          return await waiveOperatorPenalty(request, env, penaltyMatch[1], operator.email, cors || {});
        }
        const detailMatch = url.pathname.match(/^\/api\/operator\/bookings\/([0-9a-f-]{36})$/i);
        if (detailMatch && request.method === "GET") {
          return await getOperatorBooking(env, detailMatch[1], cors || {});
        }
        if (detailMatch && request.method === "PATCH") {
          return await updateOperatorBooking(request, env, detailMatch[1], operator.email, cors || {});
        }
      } catch {
        console.error(JSON.stringify({ event: "operator_request_failed" }));
        return jsonResponse({ error: "Operator request failed" }, 503, cors || {});
      }
    }

    return jsonResponse({ error: "Not found" }, 404, cors || {});
  },
};
