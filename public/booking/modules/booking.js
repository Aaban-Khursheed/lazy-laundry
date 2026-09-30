import { PRICING, STATUS_STEPS } from "./constants.js";
import { API_MODE, apiRequest } from "./api.js";
import {
  clearError,
  dateStringFromParts,
  escapeHtml,
  expectedReadyTime,
  formatDate,
  formatMoney,
  formatSlot,
  generateBookingNumber,
  getMaxBookingDateString,
  getTodayString,
  getSlotsForDate,
  isSlotBooked,
  isSlotClosed,
  isSlotInCurrentSchedule,
  isWeekend,
  saveBooking,
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
const bookingStepError = document.querySelector("#booking-step-error");
const termsAcceptedInput = document.querySelector("#terms-accepted");
const countryCodeInput = document.querySelector("#customer-country-code");
const customerPhoneInput = document.querySelector("#customer-phone");
const formError = document.querySelector("#form-error");
const submitButton = bookingForm.querySelector('[type="submit"]');

let currentBookedSlots = new Set();
let loadedAvailabilityDate = "";
let availabilityRequestId = 0;

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
    items.push({ label: "Hangers", amount: pricing.hanger });
  }

  return {
    packageSize,
    service,
    items,
    total: items.reduce((sum, item) => sum + item.amount, 0),
  };
}

function renderCalendar() {
  const today = getTodayString();
  const selectedDate = pickupDateInput.value;
  calendarGrid.innerHTML = "";

  Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(`${today}T12:00:00`);
    date.setDate(date.getDate() + offset);
    const dateString = dateStringFromParts(date.getFullYear(), date.getMonth(), date.getDate());
    const button = document.createElement("button");
    const isWeekendDate = isWeekend(dateString);
    const dayLabel = offset === 0
      ? "Today"
      : new Intl.DateTimeFormat("en", { weekday: "short" }).format(date);
    const monthLabel = new Intl.DateTimeFormat("en", { month: "short" }).format(date);
    const weekendBadge = isWeekendDate ? '<span class="calendar-day-badge">AM Pickup</span>' : "";

    button.type = "button";
    button.className = `calendar-day${isWeekendDate ? " weekend" : ""}${dateString === selectedDate ? " selected" : ""}`;
    button.setAttribute("aria-label", `${formatDate(dateString)}${isWeekendDate ? ", morning pickup available" : ""}`);
    button.setAttribute("aria-pressed", String(dateString === selectedDate));
    button.innerHTML = `<span class="calendar-day-name">${dayLabel}</span><strong>${date.getDate()}</strong><small>${monthLabel}</small>${weekendBadge}`;

    button.addEventListener("click", () => {
      pickupDateInput.value = dateString;
      pickupSlotInput.value = "";
      renderCalendar();
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
    retryButton.className = "button button-secondary";
    retryButton.textContent = "Retry availability";
    retryButton.addEventListener("click", () => refreshSlots(retryDate, true));
    slotGrid.appendChild(retryButton);
  }
}

async function loadAvailability(dateString, alignToAvailable) {
  const requestId = ++availabilityRequestId;
  currentBookedSlots = new Set();
  loadedAvailabilityDate = "";
  pickupSlotInput.value = "";
  slotGrid.classList.toggle("weekend", isWeekend(dateString));
  showAvailabilityMessage("Loading pickup availability…");

  try {
    const result = await apiRequest(`/api/availability?date=${encodeURIComponent(dateString)}`);
    if (requestId !== availabilityRequestId || pickupDateInput.value !== dateString) {
      return;
    }
    if (result?.date !== dateString || !Array.isArray(result.bookedSlots)) {
      throw new Error("The API returned an invalid availability response. Retry to try again.");
    }

    currentBookedSlots = new Set(result.bookedSlots.filter((slot) => typeof slot === "string"));
    loadedAvailabilityDate = dateString;
    renderSlots(alignToAvailable);
  } catch (error) {
    if (requestId !== availabilityRequestId || pickupDateInput.value !== dateString) {
      return;
    }
    showAvailabilityMessage(error.message || "Pickup availability could not be loaded. Retry to try again.", dateString);
  }
}

function refreshSlots(dateString, alignToAvailable = false) {
  if (API_MODE) {
    loadAvailability(dateString, alignToAvailable);
  } else {
    renderSlots(alignToAvailable);
  }
}

function isDateSlotBooked(dateString, slot) {
  return API_MODE ? currentBookedSlots.has(slot) : isSlotBooked(dateString, slot);
}

export function renderSlots(alignToAvailable = false) {
  const dateString = pickupDateInput.value;
  if (API_MODE && loadedAvailabilityDate !== dateString) {
    return;
  }

  const slots = getSlotsForDate();
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

    if (slot === selectedSlot && !button.disabled) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      pickupSlotInput.value = slot;
      renderSlots();
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
          behavior: "smooth",
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
      (item) => `<div class="breakdown-row"><span>${escapeHtml(item.label)}</span><strong>${item.included ? "Included" : formatMoney(item.amount)}</strong></div>`,
    )
    .join("");
}

export function updatePriceSummary() {
  const details = getPriceDetails();
  const breakdown = getBreakdownMarkup(details);
  expressPrice.textContent = `+${formatMoney(PRICING[details.packageSize].express)}`;
  hangerPrice.textContent = `+${formatMoney(PRICING[details.packageSize].hanger)}`;
  totalPrice.textContent = formatMoney(details.total);
  priceBreakdown.innerHTML = breakdown;
  checkoutTotalPrice.textContent = formatMoney(details.total);
  checkoutPriceBreakdown.innerHTML = breakdown;
}

export function resetBookingForm() {
  bookingForm.reset();
  pickupDateInput.value = getTodayString();
  pickupSlotInput.value = "";
  clearError(formError);
  clearError(bookingStepError);
  renderCalendar();
  refreshSlots(pickupDateInput.value, true);
  updatePriceSummary();
}

function getApiBookingPayload(formData, details) {
  const countryCode = formData.get("countryCode").trim();
  const phoneDigits = formData.get("phone").replace(/\D/g, "");
  const normalizedPhoneDigits = phoneDigits.startsWith("0") ? phoneDigits.slice(1) : phoneDigits;
  return {
    name: formData.get("name").trim(),
    phone: `${countryCode}${normalizedPhoneDigits}`,
    block: formData.get("block"),
    unit: formData.get("unit").trim(),
    packageSize: details.packageSize,
    service: details.service,
    hangers: hangersInput.checked,
    pickupDate: pickupDateInput.value,
    pickupSlot: pickupSlotInput.value,
    paymentMethod: formData.get("paymentMethod"),
    termsAccepted: termsAcceptedInput.checked,
  };
}

async function submitApiBooking(formData, details, onBookingCreated) {
  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");
  try {
    const result = await apiRequest("/api/bookings", {
      method: "POST",
      body: getApiBookingPayload(formData, details),
    });
    if (!result?.booking || typeof result.trackingToken !== "string" || !result.trackingToken) {
      throw new Error("The API returned an invalid booking response. The request could not be confirmed.");
    }
    onBookingCreated(result.booking, result.trackingToken);
  } catch (error) {
    const message = error.status === 503
      ? "Public booking is currently disabled on the staging API. Nothing was submitted."
      : error.message || "The staging API could not save this request. Nothing was submitted.";
    showError(formError, message);
    if (error.status === 409) {
      refreshSlots(pickupDateInput.value, true);
    }
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
  }
}

export function initializeBooking({ showView, onBookingCreated }) {
  checkoutButton.addEventListener("click", () => {
    clearError(bookingStepError);
    if (!pickupSlotInput.value || !isSlotInCurrentSchedule(pickupDateInput.value, pickupSlotInput.value)) {
      showError(bookingStepError, "Choose an available pickup slot before continuing.");
      return;
    }
    if (API_MODE && loadedAvailabilityDate !== pickupDateInput.value) {
      showError(bookingStepError, "Pickup availability is still loading or unavailable. Retry availability before continuing.");
      return;
    }
    showView("checkout-view");
  });

  packageInputs.forEach((input) => input.addEventListener("change", updatePriceSummary));
  serviceInputs.forEach((input) => input.addEventListener("change", updatePriceSummary));
  foldingInput.addEventListener("change", updatePriceSummary);
  ironingInput.addEventListener("change", updatePriceSummary);
  hangersInput.addEventListener("change", updatePriceSummary);
  customerPhoneInput.addEventListener("input", () => {
    customerPhoneInput.value = customerPhoneInput.value.replace(/\D/g, "").slice(0, 12);
  });
  countryCodeInput.addEventListener("input", () => {
    const digits = countryCodeInput.value.replace(/\D/g, "").slice(0, 4);
    countryCodeInput.value = digits ? `+${digits}` : "+";
  });

  bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
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

    const formData = new FormData(bookingForm);
    const details = getPriceDetails();
    if (API_MODE) {
      await submitApiBooking(formData, details, onBookingCreated);
      return;
    }

    const paymentMethod = formData.get("paymentMethod");
    const countryCode = formData.get("countryCode").trim();
    const phoneDigits = formData.get("phone").replace(/\D/g, "");
    const normalizedPhoneDigits = phoneDigits.startsWith("0") ? phoneDigits.slice(1) : phoneDigits;
    const createdAt = new Date().toISOString();
    const booking = {
      number: generateBookingNumber(),
      name: formData.get("name").trim(),
      phone: `${countryCode}${normalizedPhoneDigits}`,
      block: formData.get("block"),
      unit: formData.get("unit").trim(),
      address: `${formData.get("block")}, Unit ${formData.get("unit").trim()}, Edumetro, USJ 1`,
      packageSize: details.packageSize,
      service: details.service,
      folding: foldingInput.checked,
      ironing: ironingInput.checked,
      hangers: hangersInput.checked,
      pickupDate: pickupDateInput.value,
      pickupSlot: pickupSlotInput.value,
      total: details.total,
      paymentMethod,
      paymentStatus: "unpaid",
      termsAccepted: termsAcceptedInput.checked,
      readyTime: expectedReadyTime(pickupDateInput.value, pickupSlotInput.value, details.service),
      status: STATUS_STEPS[0],
      statusHistory: [{ status: STATUS_STEPS[0], at: createdAt }],
      createdAt,
    };

    try {
      saveBooking(booking);
    } catch {
      showError(formError, "This browser could not save the demo request. Nothing was submitted.");
      return;
    }
    onBookingCreated(booking, "");
  });

  pickupDateInput.min = getTodayString();
  pickupDateInput.max = getMaxBookingDateString();
  pickupDateInput.value = getTodayString();
  renderCalendar();
  refreshSlots(pickupDateInput.value, true);
  updatePriceSummary();
}
