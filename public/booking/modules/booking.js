import { buttonVariants } from "../../shared/variants.js";
import { PRICING, STATUS_STEPS } from "./constants.js";
import { API_MODE, apiRequest } from "./api.js";
import { getTurnstileToken } from "./turnstile.js";
import {
  clearError,
  dateStringFromParts,
  escapeHtml,
  formatDate,
  formatMoney,
  formatSlot,
  getMaxBookingDateString,
  getTodayString,
  getSlotsForDate,
  isSlotClosed,
  isSlotInCurrentSchedule,
  isWeekend,
  showError,
} from "./utils.js";

const bookingForm = document.querySelector("#booking-form");
const packageInputs = [...document.querySelectorAll('input[name="packageSize"]')];
const serviceInputs = [...document.querySelectorAll('input[name="service"]')];
const foldingInput = document.querySelector("#folding");
const ironingInput = document.querySelector("#ironing");
const hangersInput = document.querySelector("#hangers");
const pickupDateInput = document.querySelector("#pickup-date");
const calendarGrid = document.querySelector("#calendar-grid");
const pickupSlotInput = document.querySelector("#pickup-slot");
const slotGrid = document.querySelector("#slot-grid");
const expressPrice = document.querySelector("#express-price");
const hangerPrice = document.querySelector("#hanger-price");
const totalPrice = document.querySelector("#total-price");
const priceBreakdown = document.querySelector("#price-breakdown");
const checkoutButton = document.querySelector("#checkout-button");
const checkoutTotalPrice = document.querySelector("#checkout-total-price");
const checkoutPriceBreakdown = document.querySelector("#checkout-price-breakdown");
const checkoutPickupSummary = document.querySelector("#checkout-pickup-summary");
const bookingStepError = document.querySelector("#booking-step-error");
const termsAcceptedInput = document.querySelector("#terms-accepted");
const countryCodeInput = document.querySelector("#customer-country-code");
const customerPhoneInput = document.querySelector("#customer-phone");
const promoInput = document.querySelector("#customer-promo");
const promoApplyButton = document.querySelector("#promo-apply");
const promoNote = document.querySelector("#promo-note");
const formError = document.querySelector("#form-error");
const submitButton = bookingForm.querySelector('[type="submit"]');

let currentBookedSlots = new Set();
let loadedAvailabilityDate = "";
let availabilityRequestId = 0;
let currentEstimate = null;
let estimateRequestId = 0;
let estimateTimer;
let estimateInFlight = null;
let estimateController = null;
let submitting = false;
let pendingBooking = null;
let bookingEnabled = false;
const lockedControls = new Map();
const recoveryResetButton = document.querySelector("#booking-recovery-reset");

export function isBookingLocked() {
  return submitting || Boolean(pendingBooking);
}

export function setBookingEnabled(enabled) {
  bookingEnabled = enabled === true;
}

function updateBookingControls() {
  lockedControls.forEach((disabled, control) => { control.disabled = disabled; });
  lockedControls.clear();
  if (isBookingLocked()) {
    document.querySelectorAll('#booking-form input, #booking-form select, #booking-form textarea, #booking-form button, [data-view-target]').forEach((control) => {
      lockedControls.set(control, control.disabled);
      control.disabled = true;
    });
    if (!submitting && pendingBooking) submitButton.disabled = false;
  }
  recoveryResetButton.hidden = !pendingBooking || submitting;
  recoveryResetButton.disabled = submitting;
  if (submitting) submitButton.setAttribute("aria-busy", "true");
  else submitButton.removeAttribute("aria-busy");
  document.querySelector("#booking-submit-label").textContent = pendingBooking ? "Retry same booking" : "Confirm booking";
  document.dispatchEvent(new Event("customer-controls-changed"));
}

function reportBookingError(message) {
  showError(formError, message);
  formError.tabIndex = -1;
  formError.focus({ preventScroll: false });
}

function formSignature() {
  return JSON.stringify([...bookingForm.elements].filter((control) => control.name).map((control) => [control.name, control.value, control.checked ?? null]));
}

export function refreshBookingWindow(reloadAvailability = false) {
  if (isBookingLocked()) return;
  const today = getTodayString();
  const maximum = getMaxBookingDateString();
  const changed = pickupDateInput.min !== today || pickupDateInput.max !== maximum;
  pickupDateInput.min = today;
  pickupDateInput.max = maximum;
  const invalidDate = !pickupDateInput.value || pickupDateInput.value < today || pickupDateInput.value > maximum;
  if (invalidDate) {
    pickupDateInput.value = today;
    pickupSlotInput.value = "";
    showError(bookingStepError, "The pickup date is outside the current booking window. Choose a new available slot.");
  }
  if (changed || invalidDate) renderCalendar();
  if (changed || invalidDate || reloadAvailability) refreshSlots(pickupDateInput.value, true);
  else renderSlots();
}

function getSelectedPackage() {
  return Number(document.querySelector('input[name="packageSize"]:checked').value);
}

function getSelectedService() {
  return document.querySelector('input[name="service"]:checked').value;
}

function getPriceDetails() {
  const packageSize = getSelectedPackage();
  const service = getSelectedService();
  const pricing = PRICING[packageSize];
  const items = [
    { label: `${packageSize}-piece Lazy Wash`, amount: pricing.base },
  ];

  if (foldingInput.checked) {
    items.push({ label: "Folding and packing", amount: 0, included: true });
  }

  if (ironingInput.checked) {
    items.push({ label: "Ironing", amount: 0, included: true });
  }

  items.push({ label: "Pickup", amount: 0, included: true });
  items.push({ label: "Delivery", amount: 0, included: true });

  if (service === "express") {
    items.push({ label: "Express service", amount: pricing.express });
  }

  if (hangersInput.checked) {
    items.push({ label: "Hangers", amount: pricing.hanger, included: pricing.hanger === 0 });
  }

  return {
    packageSize,
    service,
    hangers: hangersInput.checked,
    promoCode: currentPromoCode(),
    items,
    total: items.reduce((sum, item) => sum + item.amount, 0),
  };
}

function renderCalendar() {
  const today = getTodayString();
  const selectedDate = pickupDateInput.value;
  calendarGrid.innerHTML = "";

  Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(`${today}T12:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + offset);
    const dateString = dateStringFromParts(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const button = document.createElement("button");
    const isWeekendDate = isWeekend(dateString);
    const dayLabel = offset === 0
      ? "Today"
      : new Intl.DateTimeFormat("en", { timeZone: "Asia/Kuala_Lumpur", weekday: "short" }).format(date);
    const monthLabel = new Intl.DateTimeFormat("en", { timeZone: "Asia/Kuala_Lumpur", month: "short" }).format(date);
    const weekendBadge = isWeekendDate ? '<span class="calendar-day-badge">AM Pickup</span>' : "";

    button.type = "button";
    button.className = `calendar-day${isWeekendDate ? " weekend" : ""}${dateString === selectedDate ? " selected" : ""}`;
    button.setAttribute("aria-label", `${formatDate(dateString)}${isWeekendDate ? ", morning pickup available" : ""}`);
    button.setAttribute("aria-pressed", String(dateString === selectedDate));
    button.innerHTML = `<span class="calendar-day-name">${dayLabel}</span><strong>${date.getUTCDate()}</strong><small>${monthLabel}</small>${weekendBadge}`;

    button.addEventListener("click", () => {
      if (isBookingLocked()) return;
      if (dateString < getTodayString() || dateString > getMaxBookingDateString()) {
        refreshBookingWindow();
        return;
      }
      pickupDateInput.value = dateString;
      pickupSlotInput.value = "";
      renderCalendar();
      calendarGrid.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      refreshSlots(dateString, true);
    });

    calendarGrid.appendChild(button);
  });
}

function showAvailabilityMessage(message, retryDate = "") {
  slotGrid.innerHTML = "";
  const status = document.createElement("p");
  status.className = "slot-availability-message";
  status.setAttribute("role", "status");
  status.textContent = message;
  slotGrid.appendChild(status);

  if (retryDate) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = buttonVariants({ intent: "secondary", size: "md", width: "full" });
    retryButton.textContent = "Retry availability";
    retryButton.addEventListener("click", () => refreshBookingWindow(true));
    slotGrid.appendChild(retryButton);
  }
}

async function loadAvailability(dateString, alignToAvailable) {
  const requestId = ++availabilityRequestId;
  currentBookedSlots = new Set();
  loadedAvailabilityDate = "";
  const selectedSlot = pickupSlotInput.value;
  slotGrid.classList.toggle("weekend", isWeekend(dateString));
  showAvailabilityMessage("Loading pickup availability…");

  try {
    const result = await apiRequest(`/api/availability?date=${encodeURIComponent(dateString)}`, { readOnly: true });
    if (requestId !== availabilityRequestId || pickupDateInput.value !== dateString || isBookingLocked()) {
      return;
    }
    if (result?.date !== dateString || !Array.isArray(result.bookedSlots)) {
      throw new Error("The API returned an invalid availability response. Retry to try again.");
    }

    currentBookedSlots = new Set(result.bookedSlots.filter((slot) => typeof slot === "string"));
    loadedAvailabilityDate = dateString;
    pickupSlotInput.value = selectedSlot;
    renderSlots(alignToAvailable);
  } catch (error) {
    if (requestId !== availabilityRequestId || pickupDateInput.value !== dateString || isBookingLocked()) {
      return;
    }
    showAvailabilityMessage(error.message || "Pickup availability could not be loaded. Retry to try again.", dateString);
  }
}

function refreshSlots(dateString, alignToAvailable = false) {
  if (isBookingLocked()) return;
  if (API_MODE) {
    loadAvailability(dateString, alignToAvailable);
  } else {
    renderSlots(alignToAvailable);
  }
}

function isDateSlotBooked(dateString, slot) {
  return currentBookedSlots.has(slot);
}

export function renderSlots(alignToAvailable = false) {
  if (isBookingLocked()) return;
  const dateString = pickupDateInput.value;
  if (API_MODE && loadedAvailabilityDate !== dateString) {
    return;
  }

  const slots = getSlotsForDate(dateString);
  const selectedSlot = pickupSlotInput.value;
  const previousScrollLeft = slotGrid.scrollLeft;
  const weekend = isWeekend(dateString);

  slotGrid.classList.toggle("weekend", weekend);
  slotGrid.innerHTML = "";

  slots.forEach((slot) => {
    const button = document.createElement("button");
    const booked = isDateSlotBooked(dateString, slot);
    const inCurrentSchedule = isSlotInCurrentSchedule(dateString, slot);
    const expired = inCurrentSchedule && isSlotClosed(dateString, slot);
    const state = booked ? "Booked" : !inCurrentSchedule ? "Coming soon" : expired ? "Expired" : "Open";
    button.type = "button";
    button.className = `slot-button ${state.toLowerCase().replaceAll(" ", "-")}`;
    button.innerHTML = `<strong>${formatSlot(slot)}</strong><small>${state}</small>`;
    button.dataset.slot = slot;
    button.disabled = booked || !inCurrentSchedule || expired;
    button.title = booked ? "Already booked" : !inCurrentSchedule ? "Coming soon" : expired ? "Slot expired" : "Open for booking";
    button.setAttribute("aria-label", `${formatSlot(slot)}, ${state.toLowerCase()}`);
    button.setAttribute("aria-pressed", String(slot === selectedSlot && !button.disabled));

    if (slot === selectedSlot && !button.disabled) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      if (isBookingLocked()) return;
      refreshBookingWindow();
      if (pickupDateInput.value !== dateString || isSlotClosed(dateString, slot)) return;
      pickupSlotInput.value = slot;
      renderSlots();
      slotGrid.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    });

    slotGrid.appendChild(button);

    if (weekend && slot === "12:00") {
      const eveningJump = document.createElement("button");
      eveningJump.type = "button";
      eveningJump.className = "slot-evening-jump";
      eveningJump.setAttribute("aria-label", "Jump to 7 PM evening pickup slots");
      eveningJump.innerHTML = "<strong>Evening</strong><small>7 PM →</small>";
      eveningJump.addEventListener("click", () => {
        const eveningSlot = slotGrid.querySelector('[data-slot="19:00"]');
        if (!eveningSlot) {
          return;
        }
        const gridLeft = slotGrid.getBoundingClientRect().left;
        const slotLeft = eveningSlot.getBoundingClientRect().left;
        slotGrid.scrollTo({
          left: Math.max(0, slotGrid.scrollLeft + slotLeft - gridLeft - 8),
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
      });
      slotGrid.appendChild(eveningJump);
    }
  });

  if (selectedSlot && (!isSlotInCurrentSchedule(dateString, selectedSlot) || isDateSlotBooked(dateString, selectedSlot) || isSlotClosed(dateString, selectedSlot))) {
    pickupSlotInput.value = "";
  }

  if (alignToAvailable) {
    const slotButtons = [...slotGrid.querySelectorAll(".slot-button")];
    const openIndex = slots.findIndex((slot) => isSlotInCurrentSchedule(dateString, slot) && !isDateSlotBooked(dateString, slot) && !isSlotClosed(dateString, slot));
    const target = slotButtons[openIndex >= 0 ? openIndex : slots.findIndex((slot) => isSlotInCurrentSchedule(dateString, slot))];
    if (target) {
      const targetOffset = target.getBoundingClientRect().left - slotGrid.getBoundingClientRect().left + slotGrid.scrollLeft;
      slotGrid.scrollLeft = Math.max(0, targetOffset - slotGrid.clientLeft - 10);
    }
  } else {
    slotGrid.scrollLeft = previousScrollLeft;
  }
}

function getBreakdownMarkup(details) {
  return details.items
    .map(
      (item) => `<div class="breakdown-row${item.promo ? " breakdown-row-promo" : ""}"><span>${escapeHtml(item.label)}</span><strong>${item.included ? "Included" : item.amount < 0 ? `−${formatMoney(-item.amount)}` : formatMoney(item.amount)}</strong></div>`,
    )
    .join("");
}

function renderPromoNote(estimate) {
  if (!promoNote) return;
  const promo = estimate?.promo;
  if (!promo) {
    promoNote.hidden = true;
    promoNote.textContent = "";
    promoNote.classList.remove("promo-note-error");
    return;
  }
  promoNote.hidden = false;
  promoNote.classList.toggle("promo-note-error", !promo.applied);
  promoNote.textContent = promo.applied
    ? `${promo.code} applied — you save ${formatMoney(Number(promo.discount) || 0)}.`
    : promo.message || "That code is not valid for this order.";
}

function normalizedPhone(countryCode, phone) {
  const code = String(countryCode || "").trim();
  const digits = String(phone || "").replace(/\D/g, "");
  const normalizedDigits = digits.startsWith("0") ? digits.slice(1) : digits;
  return `${code}${normalizedDigits}`;
}

function currentPromoCode() {
  return (promoInput?.value || "").trim().toUpperCase();
}

function estimateKey(details, phone) {
  return `${phone}|${details.packageSize}|${details.service}|${details.hangers ? "1" : "0"}|${details.promoCode || ""}`;
}

function renderPriceSummary(details) {
  const breakdown = getBreakdownMarkup(details);
  expressPrice.textContent = `+${formatMoney(PRICING[details.packageSize].express)}`;
  hangerPrice.textContent = PRICING[details.packageSize].hanger === 0 ? "Included" : `+${formatMoney(PRICING[details.packageSize].hanger)}`;
  totalPrice.textContent = formatMoney(details.total);
  priceBreakdown.innerHTML = breakdown;
  checkoutTotalPrice.textContent = formatMoney(details.total);
  checkoutPriceBreakdown.innerHTML = breakdown;
}

export function updatePriceSummary() {
  const details = getPriceDetails();
  const phone = normalizedPhone(countryCodeInput.value, customerPhoneInput.value);
  const estimate = currentEstimate?.key === estimateKey(details, phone) ? currentEstimate : null;
  renderPriceSummary(estimate ? { ...details, items: estimate.items, total: estimate.total } : details);
  renderPromoNote(estimate);
}

async function refreshEstimate(force = false) {
  const details = getPriceDetails();
  const phone = normalizedPhone(countryCodeInput.value, customerPhoneInput.value);
  const key = estimateKey(details, phone);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error("Enter a valid phone number to get the server quote.");
  if (!force && currentEstimate?.key === key) return currentEstimate;
  if (!force && estimateInFlight?.key === key) return estimateInFlight.promise;
  estimateController?.abort();
  const controller = new AbortController();
  estimateController = controller;
  const requestId = ++estimateRequestId;
  const promise = (async () => {
    try {
      const turnstileToken = await getTurnstileToken("estimate");
      if (controller.signal.aborted) throw new DOMException("Quote was replaced", "AbortError");
      const result = await apiRequest("/api/estimate", {
        method: "POST", readOnly: true, signal: controller.signal,
        headers: turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {},
        body: { phone, packageSize: details.packageSize, service: details.service, hangers: details.hangers, promoCode: details.promoCode || undefined },
      });
      if (requestId !== estimateRequestId || estimateKey(getPriceDetails(), normalizedPhone(countryCodeInput.value, customerPhoneInput.value)) !== key) {
        throw new Error("Your details changed while the quote loaded. Review your details and try again.");
      }
      if (typeof result?.revision !== "string" || !result.revision || typeof result.total !== "number" || !Number.isFinite(result.total) || result.total < 0 || !Array.isArray(result.lines) || !result.lines.length || result.lines.some((line) => typeof line.label !== "string" || typeof line.amount !== "number" || !Number.isFinite(line.amount) || (line.amount < 0 && line.key !== "promo") || (line.amount >= 0 && line.key === "promo")) || Math.round(result.lines.reduce((total, line) => total + line.amount, 0) * 100) !== Math.round(result.total * 100)) {
        throw new Error("The server quote could not be verified. Retry the quote before confirming.");
      }
      currentEstimate = {
        key, revision: result.revision, total: result.total,
        promo: result.promo && typeof result.promo === "object" ? result.promo : null,
        items: result.lines.map((line) => ({ label: line.label, amount: line.amount, included: line.amount === 0, promo: line.key === "promo" })),
      };
      updatePriceSummary();
      return currentEstimate;
    } catch (error) {
      if (requestId === estimateRequestId) {
        currentEstimate = null;
        updatePriceSummary();
      }
      throw error;
    } finally {
      if (estimateInFlight?.requestId === requestId) estimateInFlight = null;
    }
  })();
  estimateInFlight = { key, requestId, promise };
  return promise;
}

function scheduleEstimate() {
  if (isBookingLocked()) return;
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => {
    refreshEstimate().catch((error) => {
      if (!isBookingLocked() && error.name !== "AbortError") showError(formError, `The server quote is unavailable. Retry before confirming. ${error.message}`);
    });
  }, 250);
}

export function resetBookingForm() {
  if (isBookingLocked()) return false;
  currentEstimate = null;
  estimateRequestId += 1;
  estimateController?.abort();
  estimateInFlight = null;
  clearTimeout(estimateTimer);
  bookingForm.reset();
  pickupDateInput.min = getTodayString();
  pickupDateInput.max = getMaxBookingDateString();
  pickupDateInput.value = getTodayString();
  pickupSlotInput.value = "";
  clearError(formError);
  clearError(bookingStepError);
  renderPromoNote(null);
  renderCalendar();
  refreshSlots(pickupDateInput.value, true);
  updatePriceSummary();
  return true;
}

function getApiBookingPayload(formData) {
  return {
    name: formData.get("name").trim(),
    phone: normalizedPhone(formData.get("countryCode"), formData.get("phone")),
    block: formData.get("block"),
    unit: formData.get("unit").trim(),
    packageSize: Number(formData.get("packageSize")),
    service: formData.get("service"),
    hangers: formData.has("hangers"),
    pickupDate: formData.get("pickupDate"),
    pickupSlot: formData.get("pickupSlot"),
    paymentMethod: formData.get("paymentMethod"),
    promoCode: (formData.get("promoCode") || "").trim().toUpperCase(),
    termsAccepted: formData.has("termsAccepted"),
  };
}

async function submitApiBooking(payload, signature, onBookingCreated) {
  let sent = false;
  let slotConflict = false;
  try {
    if (!pendingBooking) {
      const displayedTotal = Number(checkoutTotalPrice.textContent.replace(/^RM/, ""));
      let estimate;
      try {
        estimate = await refreshEstimate();
      } catch (error) {
        throw new Error(`The server quote is unavailable. Retry the quote before confirming. ${error.message}`);
      }
      if (formSignature() !== signature || estimate?.key !== estimateKey(payload, payload.phone)) {
        throw new Error("Your details changed while the quote loaded. Review the current details and try again.");
      }
      if (!Number.isFinite(displayedTotal) || Math.round(displayedTotal * 100) !== Math.round(estimate.total * 100)) {
        reportBookingError(`Your server quote is ${formatMoney(estimate.total)}. Review the total and any fees, then confirm again.`);
        return;
      }
      payload = { ...payload, priceRevision: estimate.revision, expectedTotalCents: Math.round(estimate.total * 100) };
    }
    const turnstileToken = await getTurnstileToken("booking");
    if (!pendingBooking && formSignature() !== signature) throw new Error("Your details changed during verification. Review them and try again.");
    if (!pendingBooking && (payload.pickupDate < getTodayString() || payload.pickupDate > getMaxBookingDateString() || isSlotClosed(payload.pickupDate, payload.pickupSlot))) {
      slotConflict = true;
      throw new Error("The pickup time expired during confirmation. Choose an available pickup slot.");
    }
    pendingBooking ||= { key: crypto.randomUUID(), payload: Object.freeze(payload) };
    sent = true;
    const result = await apiRequest("/api/bookings", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": pendingBooking.key,
        ...(turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {}),
      },
      body: pendingBooking.payload,
    });
    if (!result?.booking || !/^LL-[A-F0-9]{8}$/.test(result.booking.number) || !/^[A-Za-z0-9_-]{43}$/.test(result.trackingToken) || !/^\d{4}-\d{2}-\d{2}$/.test(result.booking.pickupDate) || !getSlotsForDate(result.booking.pickupDate).includes(result.booking.pickupSlot) || typeof result.booking.total !== "number" || !Number.isFinite(result.booking.total) || result.booking.total < 0 || !PRICING[result.booking.packageSize] || typeof result.booking.readyTime !== "string") {
      const error = new Error("The booking confirmation response could not be verified.");
      error.outcomeUnknown = true;
      throw error;
    }
    onBookingCreated(result.booking, result.trackingToken);
    pendingBooking = null;
  } catch (error) {
    if (pendingBooking && (!sent || error.outcomeUnknown || !error.status)) {
      reportBookingError(`Your confirmation could not be verified; retry the same booking. It may already be saved. Your original details are protected until confirmation is recovered.${!sent ? ` ${error.message}` : ""}`);
    } else {
      if (sent) pendingBooking = null;
      if (error.status === 409 && error.code === "quote_changed") {
        currentEstimate = null;
        try {
          const estimate = await refreshEstimate(true);
          reportBookingError(`The total has been updated to ${formatMoney(estimate.total)}. Review the updated quote and fees, then confirm again. Your pickup selection is unchanged.`);
        } catch (quoteError) {
          reportBookingError(`The quote changed, but the new quote could not be loaded. Retry before confirming. ${quoteError.message}`);
        }
      } else {
        slotConflict ||= error.status === 409;
        reportBookingError(error.status === 503 ? "Booking is currently unavailable. Please try again." : error.message || "The booking could not be confirmed. Please try again.");
      }
    }
  } finally {
    submitting = false;
    updateBookingControls();
    if (slotConflict) {
      pickupSlotInput.value = "";
      refreshBookingWindow(true);
      reportBookingError("That pickup slot could not be reserved. Your details are preserved; choose an available pickup slot before confirming again.");
    }
  }
}

export function initializeBooking({ showView, onBookingCreated }) {
  checkoutButton.addEventListener("click", () => {
    if (isBookingLocked() || !bookingEnabled) return;
    refreshBookingWindow();
    clearError(bookingStepError);
    if (!pickupSlotInput.value || !isSlotInCurrentSchedule(pickupDateInput.value, pickupSlotInput.value)) {
      showError(bookingStepError, "Choose an available pickup slot before continuing.");
      return;
    }
    if (API_MODE && loadedAvailabilityDate !== pickupDateInput.value) {
      showError(bookingStepError, "Pickup availability is still loading or unavailable. Retry availability before continuing.");
      return;
    }
    checkoutPickupSummary.textContent = `${formatDate(pickupDateInput.value)} · ${formatSlot(pickupSlotInput.value)} MYT`;
    showView("checkout-view");
  });

  packageInputs.forEach((input) => input.addEventListener("change", () => {
    updatePriceSummary();
    scheduleEstimate();
  }));
  serviceInputs.forEach((input) => input.addEventListener("change", () => {
    updatePriceSummary();
    scheduleEstimate();
  }));
  foldingInput.addEventListener("change", updatePriceSummary);
  ironingInput.addEventListener("change", updatePriceSummary);
  hangersInput.addEventListener("change", () => {
    updatePriceSummary();
    scheduleEstimate();
  });
  customerPhoneInput.addEventListener("input", () => {
    customerPhoneInput.value = customerPhoneInput.value.replace(/\D/g, "").slice(0, 12);
  });
  countryCodeInput.addEventListener("input", () => {
    const digits = countryCodeInput.value.replace(/\D/g, "").slice(0, 4);
    countryCodeInput.value = digits ? `+${digits}` : "+";
  });
  customerPhoneInput.addEventListener("blur", scheduleEstimate);
  countryCodeInput.addEventListener("blur", scheduleEstimate);
  promoInput?.addEventListener("input", () => {
    renderPromoNote(null);
    if (/^\+[1-9]\d{6,14}$/.test(normalizedPhone(countryCodeInput.value, customerPhoneInput.value))) scheduleEstimate();
  });
  promoInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      promoApplyButton?.click();
    }
  });
  promoApplyButton?.addEventListener("click", () => {
    if (isBookingLocked()) return;
    promoApplyButton.disabled = true;
    refreshEstimate(true)
      .catch((error) => { if (error.name !== "AbortError") showError(formError, `The server quote is unavailable. Retry before confirming. ${error.message}`); })
      .finally(() => { promoApplyButton.disabled = false; });
  });

  bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!bookingEnabled && !pendingBooking) {
      reportBookingError("Bookings are unavailable until the service configuration is verified. Retry from the home screen.");
      return;
    }
    if (pendingBooking) {
      submitting = true;
      updateBookingControls();
      clearError(formError);
      await submitApiBooking(null, "", onBookingCreated);
      return;
    }
    refreshBookingWindow();
    clearError(formError);

    if (!bookingForm.checkValidity()) {
      showError(formError, "Complete your contact details, choose a block and unit, select a pickup slot, and accept the terms.");
      bookingForm.reportValidity();
      return;
    }

    if (!pickupSlotInput.value || !isSlotInCurrentSchedule(pickupDateInput.value, pickupSlotInput.value)) {
      showError(formError, "Choose an available pickup slot before confirming.");
      return;
    }

    if (API_MODE && loadedAvailabilityDate !== pickupDateInput.value) {
      showError(formError, "Pickup availability is still loading or unavailable. Retry availability before confirming.");
      return;
    }

    if (isDateSlotBooked(pickupDateInput.value, pickupSlotInput.value) || isSlotClosed(pickupDateInput.value, pickupSlotInput.value)) {
      showError(formError, "That pickup slot is no longer available. Please choose another slot.");
      refreshSlots(pickupDateInput.value, true);
      return;
    }

    const payload = getApiBookingPayload(new FormData(bookingForm));
    const signature = formSignature();
    clearTimeout(estimateTimer);
    submitting = true;
    updateBookingControls();
    await submitApiBooking(payload, signature, onBookingCreated);
  });

  recoveryResetButton.addEventListener("click", () => {
    if (submitting || !pendingBooking) return;
    if (!window.confirm("The original booking may already be saved. Retry the same booking first to recover confirmation. Editing now abandons that recovery and a new submission could create another booking. Do you acknowledge this risk and want to edit anyway?")) return;
    pendingBooking = null;
    currentEstimate = null;
    updateBookingControls();
    refreshBookingWindow(true);
    reportBookingError("You acknowledged that the original booking may be saved. Check its status or contact Lazy Laundry before creating another booking.");
    submitButton.focus();
  });
  bookingForm.addEventListener("reset", (event) => { if (isBookingLocked()) event.preventDefault(); });
  window.addEventListener("focus", () => refreshBookingWindow());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBookingWindow(); });
  window.addEventListener("beforeunload", (event) => {
    if (isBookingLocked()) { event.preventDefault(); event.returnValue = ""; }
  });

  pickupDateInput.min = getTodayString();
  pickupDateInput.max = getMaxBookingDateString();
  pickupDateInput.value = getTodayString();
  renderCalendar();
  refreshSlots(pickupDateInput.value, true);
  updatePriceSummary();
}
