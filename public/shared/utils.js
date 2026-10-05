const SERVICE_TIMEZONE = "Asia/Kuala_Lumpur";

function serviceDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function getTodayString() {
  const parts = serviceDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getMaxBookingDateString() {
  const date = new Date(`${getTodayString()}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + 6);
  const parts = serviceDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isWeekend(dateString) {
  const date = new Date(`${dateString}T12:00:00+08:00`);
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function getSlotsForDate(dateString) {
  const slots = ["19:00", "20:00", "21:00"];
  if (isWeekend(dateString)) slots.unshift("10:00", "11:00", "12:00");
  return slots;
}

export function isSlotInCurrentSchedule(dateString, slot) {
  return getSlotsForDate(dateString).includes(slot);
}

export function formatSlot(slot) {
  return new Intl.DateTimeFormat("en", { timeZone: SERVICE_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(`2000-01-01T${slot}:00+08:00`));
}

export function formatDate(dateString) {
  return new Intl.DateTimeFormat("en", { timeZone: SERVICE_TIMEZONE, weekday: "long", day: "numeric", month: "short" }).format(new Date(`${dateString}T12:00:00+08:00`));
}

export function dateStringFromParts(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatMoney(amount) {
  return `RM${Number(amount).toFixed(2)}`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function isSlotClosed(dateString, slot) {
  if (dateString !== getTodayString()) return false;
  return Date.now() >= Date.parse(`${dateString}T${slot}:00+08:00`) + 45 * 60 * 1000;
}

export function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

export function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

export function getStatusHistory(booking, statusSteps) {
  if (Array.isArray(booking.statusHistory) && booking.statusHistory.length) {
    return booking.statusHistory.filter((entry) => entry && typeof entry.status === "string");
  }
  return [{ status: booking.status || statusSteps[0], at: booking.createdAt }];
}

export function getStatusClass(status) {
  return `status-${String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function formatAdminTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not recorded";
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
