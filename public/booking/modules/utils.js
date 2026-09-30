export function getTodayString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getMaxBookingDateString() {
  const date = new Date(`${getTodayString()}T12:00:00`);
  date.setDate(date.getDate() + 6);
  return dateStringFromParts(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isWeekend(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function getSlotsForDate() {
  return [...Array.from({ length: 14 }, (_, index) => `${String(index + 10).padStart(2, "0")}:00`), "00:00"];
}

export function isSlotInCurrentSchedule(dateString, slot) {
  const currentEveningSlots = ["19:00", "20:00", "21:00"];
  const currentWeekendMorningSlots = ["10:00", "11:00", "12:00"];
  return currentEveningSlots.includes(slot) || (isWeekend(dateString) && currentWeekendMorningSlots.includes(slot));
}

export function formatSlot(slot) {
  const [hours, minutes] = slot.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDate(dateString) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(`${dateString}T12:00:00`));
}

export function dateStringFromParts(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatMoney(amount) {
  return `RM${amount.toFixed(2)}`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function readBookings() {
  try {
    const bookings = JSON.parse(localStorage.getItem("lazyLaundryBookings") || "[]");
    return Array.isArray(bookings) ? bookings.filter((booking) => booking && typeof booking === "object") : [];
  } catch {
    return [];
  }
}

export function saveBookings(bookings) {
  localStorage.setItem("lazyLaundryBookings", JSON.stringify(bookings));
}

export function saveBooking(booking) {
  saveBookings([...readBookings(), booking]);
}

export function updateBooking(number, update) {
  const bookings = readBookings();
  const index = bookings.findIndex((booking) => booking.number === number);
  if (index < 0) {
    return null;
  }
  bookings[index] = update(bookings[index]);
  saveBookings(bookings);
  return bookings[index];
}

export function generateBookingNumber() {
  const existing = new Set(readBookings().map((booking) => booking.number));
  let number;
  do {
    number = `LL-${Math.floor(1000 + Math.random() * 9000)}`;
  } while (existing.has(number));
  return number;
}

export function isSlotClosed(dateString, slot) {
  if (dateString !== getTodayString()) {
    return false;
  }

  const [hours, minutes] = slot.split(":").map(Number);
  const expiry = new Date();
  expiry.setHours(hours, minutes + 45, 0, 0);
  return new Date() >= expiry;
}

export function isSlotBooked(dateString, slot) {
  return readBookings().some(
    (booking) => booking.pickupDate === dateString && booking.pickupSlot === slot,
  );
}

export function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

export function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

export function expectedReadyTime(dateString, slot, service) {
  const [hours, minutes] = slot.split(":").map(Number);
  const pickup = new Date(`${dateString}T00:00:00`);
  pickup.setHours(hours, minutes, 0, 0);

  if (service === "express") {
    pickup.setHours(pickup.getHours() + 6);
  } else if (hours >= 19) {
    pickup.setDate(pickup.getDate() + 1);
    pickup.setHours(hours - 9, minutes, 0, 0);
  } else {
    pickup.setHours(pickup.getHours() + 12);
  }

  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(pickup);
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
  if (Number.isNaN(date.getTime())) {
    return "Time not recorded";
  }
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
