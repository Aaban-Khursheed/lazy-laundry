const STATUS_CODES = [
  "booking_received",
  "confirmed",
  "pickup_on_the_way",
  "laundry_picked_up",
  "processing",
  "ready",
  "delivered",
];

const STATUS_LABELS = {
  booking_received: "Booking received",
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
const MAX_BODY_BYTES = 16 * 1024;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return {};
  }
  const allowedOrigins = [env.CUSTOMER_ORIGIN, env.OPERATOR_ORIGIN].filter(Boolean);
  if (!allowedOrigins.includes(origin)) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "300",
    Vary: "Origin",
  };
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

function readyAtFor(dateString, slot, service) {
  const pickupAt = Date.parse(`${dateString}T${slot}:00+08:00`);
  const pickupHour = Number(slot.slice(0, 2));
  const hours = service === "express" ? 6 : pickupHour >= 19 ? 15 : 12;
  return new Date(pickupAt + hours * 60 * 60 * 1000).toISOString();
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
  const base = packageSize === 10 ? 3499 : 5999;
  const express = packageSize === 10 ? 1000 : 1500;
  const hanger = packageSize === 10 ? 300 : 500;
  return base + (service === "express" ? express : 0) + (hangers ? hanger : 0);
}

function validateBooking(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
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
  if (!BLOCKS.has(block) || !unit || unit.length > 40) return null;
  if (![10, 18].includes(packageSize) || !["standard", "express"].includes(service)) return null;
  if (!["cash", "qr"].includes(paymentMethod) || input.termsAccepted !== true) return null;
  if (!isPickupSlotAvailable(pickupDate, pickupSlot)) return null;

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

function bookingForClient(row) {
  return {
    id: row.id,
    number: row.booking_number,
    name: row.customer_name,
    phone: row.phone,
    block: row.block,
    unit: row.unit,
    address: `${row.block}, Unit ${row.unit}, Edumetro, USJ 1`,
    packageSize: row.package_size,
    service: row.service,
    folding: true,
    ironing: true,
    hangers: Boolean(row.hangers),
    pickupDate: row.pickup_date,
    pickupSlot: row.pickup_slot,
    total: row.total_cents / 100,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    termsAccepted: Boolean(row.terms_accepted),
    readyAt: row.ready_at,
    readyTime: formatReadyTime(row.ready_at),
    status: STATUS_LABELS[row.status] || row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createBooking(request, env, cors) {
  if (env.PUBLIC_BOOKING_ENABLED !== "true" || !env.CUSTOMER_ORIGIN) {
    return jsonResponse({ error: "Booking intake is not enabled" }, 503, cors);
  }
  const input = await readJson(request);
  const booking = validateBooking(input);
  if (!booking) {
    return jsonResponse({ error: "Booking details are invalid or the pickup slot is unavailable" }, 400, cors);
  }

  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const trackingToken = makeTrackingToken();
    const trackingTokenHash = await sha256(trackingToken);
    const bookingNumber = `LL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO bookings (
            id, booking_number, tracking_token_hash, customer_name, phone, block, unit,
            package_size, service, folding, ironing, hangers, pickup_date, pickup_slot,
            total_cents, payment_method, status, ready_at, created_at, updated_at, terms_accepted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 'booking_received', ?, ?, ?, 1)
        `).bind(
          id,
          bookingNumber,
          trackingTokenHash,
          booking.name,
          booking.phone,
          booking.block,
          booking.unit,
          booking.packageSize,
          booking.service,
          booking.hangers ? 1 : 0,
          booking.pickupDate,
          booking.pickupSlot,
          booking.totalCents,
          booking.paymentMethod,
          booking.readyAt,
          createdAt,
          createdAt,
        ),
        env.DB.prepare(`
          INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
          VALUES (?, ?, 'status', NULL, 'booking_received', NULL, ?)
        `).bind(eventId, id, createdAt),
      ]);
      if (results[0]?.meta?.changes !== 1) {
        throw new Error("Booking insert did not change a row");
      }
      return jsonResponse({
        booking: bookingForClient({
          ...booking,
          id,
          booking_number: bookingNumber,
          customer_name: booking.name,
          package_size: booking.packageSize,
          pickup_date: booking.pickupDate,
          pickup_slot: booking.pickupSlot,
          total_cents: booking.totalCents,
          payment_method: booking.paymentMethod,
          payment_status: "unpaid",
          status: "booking_received",
          ready_at: booking.readyAt,
          created_at: createdAt,
          updated_at: createdAt,
          terms_accepted: 1,
        }),
        trackingToken,
      }, 201, cors);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("bookings.pickup_date, bookings.pickup_slot")) {
        return jsonResponse({ error: "That pickup slot has just been taken" }, 409, cors);
      }
      if (message.includes("bookings.booking_number")) {
        continue;
      }
      console.error(JSON.stringify({ event: "booking_create_failed", errorType: error instanceof Error ? error.name : "unknown" }));
      return jsonResponse({ error: "Booking could not be saved" }, 503, cors);
    }
  }
  return jsonResponse({ error: "Booking could not be saved" }, 503, cors);
}

async function getAvailability(request, env, cors) {
  const date = new URL(request.url).searchParams.get("date");
  if (!isValidDate(date) || date < dateInKualaLumpur() || date > addLocalDays(dateInKualaLumpur(), 6)) {
    return jsonResponse({ error: "Date is outside the booking window" }, 400, cors);
  }
  const result = await env.DB.prepare(`
    SELECT pickup_slot FROM bookings WHERE pickup_date = ? AND status <> 'cancelled'
  `).bind(date).all();
  return jsonResponse({ date, bookedSlots: result.results.map((row) => row.pickup_slot) }, 200, cors);
}

async function getTracking(request, env, token, cors) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return jsonResponse({ error: "Request not found" }, 404, cors);
  }
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT booking_number, package_size, service, pickup_date, pickup_slot, total_cents, ready_at, status
    FROM bookings WHERE tracking_token_hash = ?
  `).bind(tokenHash).first();
  if (!row) {
    return jsonResponse({ error: "Request not found" }, 404, cors);
  }
  return jsonResponse({
    number: row.booking_number,
    packageSize: row.package_size,
    service: row.service,
    pickupDate: row.pickup_date,
    pickupSlot: row.pickup_slot,
    total: row.total_cents / 100,
    readyAt: row.ready_at,
    readyTime: formatReadyTime(row.ready_at),
    status: STATUS_LABELS[row.status] || row.status,
  }, 200, cors);
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
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer || !audiences.includes(env.ACCESS_AUD) || !Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) {
    return { kind: "invalid" };
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  const allowlist = env.OPERATOR_ALLOWED_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowlist.includes(email)) return { kind: "forbidden" };

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
    return validSignature ? { kind: "valid", email } : { kind: "invalid" };
  } catch {
    return { kind: "unavailable" };
  }
}

function statusEventRow(row) {
  return {
    status: STATUS_LABELS[row.to_value] || row.to_value,
    at: row.created_at,
    actor: row.actor_id,
  };
}

async function getOperatorBookings(request, env, cors) {
  const url = new URL(request.url);
  const filter = url.searchParams.get("status") || "all";
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
  const clauses = {
    all: "1 = 1",
    pending: "status = 'booking_received'",
    active: "status NOT IN ('booking_received', 'delivered', 'cancelled')",
    completed: "status = 'delivered'",
    cancelled: "status = 'cancelled'",
  };
  if (!Object.hasOwn(clauses, filter)) {
    return jsonResponse({ error: "Invalid status filter" }, 400, cors);
  }
  const [result, summary] = await Promise.all([
    env.DB.prepare(`
      SELECT id, booking_number, customer_name, phone, block, unit, package_size, service,
        hangers, pickup_date, pickup_slot, total_cents, payment_method, payment_status,
        status, ready_at, created_at, updated_at
      FROM bookings WHERE ${clauses[filter]}
      ORDER BY pickup_date, pickup_slot LIMIT ?
    `).bind(limit).all(),
    env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'booking_received' THEN 1 END) AS pending,
        COUNT(CASE WHEN status NOT IN ('booking_received', 'delivered', 'cancelled') THEN 1 END) AS active,
        COUNT(CASE WHEN payment_status = 'unpaid' AND status <> 'cancelled' THEN 1 END) AS unpaid
      FROM bookings
    `).first(),
  ]);
  return jsonResponse({
    bookings: result.results.map(bookingForClient),
    summary: {
      pending: Number(summary?.pending) || 0,
      active: Number(summary?.active) || 0,
      unpaid: Number(summary?.unpaid) || 0,
    },
  }, 200, cors);
}

async function getOperatorBooking(env, id, cors) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!row) return jsonResponse({ error: "Booking not found" }, 404, cors);
  const events = await env.DB.prepare(`
    SELECT event_type, from_value, to_value, actor_id, created_at
    FROM booking_events WHERE booking_id = ? ORDER BY created_at
  `).bind(id).all();
  const booking = bookingForClient(row);
  booking.statusHistory = events.results.filter((event) => event.event_type === "status").map(statusEventRow);
  booking.events = events.results.map((event) => ({
    type: event.event_type,
    from: event.from_value,
    to: event.event_type === "status" ? STATUS_LABELS[event.to_value] || event.to_value : event.to_value,
    actor: event.actor_id,
    at: event.created_at,
  }));
  return jsonResponse({ booking }, 200, cors);
}

async function updateOperatorBooking(request, env, id, actor, cors) {
  const input = await readJson(request);
  if (!input || !["advance", "cancel", "paid"].includes(input.action)) {
    return jsonResponse({ error: "Invalid update" }, 400, cors);
  }
  const current = await env.DB.prepare("SELECT id, status, payment_status FROM bookings WHERE id = ?").bind(id).first();
  if (!current) return jsonResponse({ error: "Booking not found" }, 404, cors);

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  let update;
  let event;

  if (input.action === "advance") {
    const index = STATUS_CODES.indexOf(current.status);
    const next = index >= 0 ? STATUS_CODES[index + 1] : null;
    if (!next) return jsonResponse({ error: "Booking cannot advance further" }, 409, cors);
    update = env.DB.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ? AND status = ?").bind(next, now, id, current.status);
    event = env.DB.prepare(`
      INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
      SELECT ?, ?, 'status', ?, ?, ?, ? WHERE changes() = 1
    `).bind(eventId, id, current.status, next, actor, now);
  } else if (input.action === "cancel") {
    const pickupIndex = STATUS_CODES.indexOf("laundry_picked_up");
    const currentIndex = STATUS_CODES.indexOf(current.status);
    if (currentIndex < 0 || currentIndex >= pickupIndex) {
      return jsonResponse({ error: "Booking can no longer be cancelled" }, 409, cors);
    }
    update = env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = ?").bind(now, id, current.status);
    event = env.DB.prepare(`
      INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
      SELECT ?, ?, 'status', ?, 'cancelled', ?, ? WHERE changes() = 1
    `).bind(eventId, id, current.status, actor, now);
  } else {
    if (current.payment_status !== "unpaid" || current.status === "cancelled") {
      return jsonResponse({ error: "Payment cannot be updated" }, 409, cors);
    }
    update = env.DB.prepare("UPDATE bookings SET payment_status = 'paid', updated_at = ? WHERE id = ? AND payment_status = 'unpaid' AND status <> 'cancelled'").bind(now, id);
    event = env.DB.prepare(`
      INSERT INTO booking_events (id, booking_id, event_type, from_value, to_value, actor_id, created_at)
      SELECT ?, ?, 'payment', 'unpaid', 'paid', ?, ? WHERE changes() = 1
    `).bind(eventId, id, actor, now);
  }

  try {
    const results = await env.DB.batch([update, event]);
    if (results[0]?.meta?.changes !== 1) {
      return jsonResponse({ error: "Booking changed; refresh and try again" }, 409, cors);
    }
    return getOperatorBooking(env, id, cors);
  } catch (error) {
    console.error(JSON.stringify({ event: "operator_update_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return jsonResponse({ error: "Update could not be saved" }, 503, cors);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env);
    if (cors === null) return jsonResponse({ error: "Origin is not allowed" }, 403);
    if (request.method === "OPTIONS") {
      return cors ? new Response(null, { status: 204, headers: cors }) : jsonResponse({ error: "Origin is not allowed" }, 403);
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

    if (request.method === "GET" && url.pathname === "/api/availability") {
      try {
        return await getAvailability(request, env, cors || {});
      } catch {
        console.error(JSON.stringify({ event: "availability_lookup_failed" }));
        return jsonResponse({ error: "Availability could not be loaded" }, 503, cors || {});
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

    const trackingMatch = url.pathname.match(/^\/api\/track\/([^/]+)$/);
    if (request.method === "GET" && trackingMatch) {
      try {
        return await getTracking(request, env, trackingMatch[1], cors || {});
      } catch {
        console.error(JSON.stringify({ event: "tracking_lookup_failed" }));
        return jsonResponse({ error: "Tracking could not be loaded" }, 503, cors || {});
      }
    }

    if (url.pathname === "/api/operator/bookings" || url.pathname.startsWith("/api/operator/bookings/")) {
      const operator = await requireOperator(request, env, cors || {});
      if (operator.response) return operator.response;
      try {
        if (request.method === "GET" && url.pathname === "/api/operator/bookings") {
          return await getOperatorBookings(request, env, cors || {});
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
