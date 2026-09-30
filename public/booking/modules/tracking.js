import {
  PAYMENT_LABELS,
  SERVICE_LABELS,
  STATUS_CANCELLED,
  STATUS_STEPS,
} from "./constants.js";
import { API_MODE, apiRequest } from "./api.js";
import {
  clearError,
  escapeHtml,
  formatDate,
  formatMoney,
  formatSlot,
  readBookings,
  showError,
} from "./utils.js";

const trackingNumberInput = document.querySelector("#tracking-number");
const trackingError = document.querySelector("#tracking-error");
const trackingResult = document.querySelector("#tracking-result");
const confirmationNumber = document.querySelector("#confirmation-number");
const confirmationDetails = document.querySelector("#confirmation-details");
const confirmationEyebrow = document.querySelector("#confirmation-view .eyebrow");
const confirmationHeading = document.querySelector("#confirmation-view h2");
const confirmationCopy = document.querySelector(".confirmation-copy");
const confirmationTrackButton = document.querySelector('#confirmation-view [data-view-target="tracking-view"]');
const trackingInputLabel = document.querySelector('label[for="tracking-number"]');
const trackingIntro = document.querySelector(".tracking-intro");
const trackButton = document.querySelector("#track-button");

let activeTrackingToken = "";
let trackingRequestId = 0;

export function renderConfirmation(booking, trackingToken = "") {
  const extras = [
    booking.folding ? "Folding and packing" : null,
    booking.ironing ? "Ironing" : null,
    booking.hangers ? "Hangers" : null,
  ].filter(Boolean);

  confirmationNumber.textContent = booking.number;
  if (API_MODE) {
    activeTrackingToken = trackingToken;
    confirmationEyebrow.textContent = "Staging request";
    confirmationHeading.textContent = "Request received.";
    confirmationCopy.textContent = "This request was saved in the staging database and reserves a staging slot only. It is not a live-service confirmation, and no customer notification was sent.";
    confirmationTrackButton.textContent = "Track staging request";
  } else {
    activeTrackingToken = "";
    confirmationEyebrow.textContent = "Local demo request";
    confirmationHeading.textContent = "Request saved.";
    confirmationCopy.textContent = "This request is stored only in this browser. It has not been sent to an operator, confirmed, or reserved.";
    confirmationTrackButton.textContent = "View local status";
  }

  confirmationDetails.innerHTML = `
    ${API_MODE ? `<div class="tracking-token-card"><label class="field-label" for="confirmation-tracking-token">Private tracking token</label><div class="tracking-token-controls"><input class="text-input" id="confirmation-tracking-token" type="text" value="${escapeHtml(trackingToken)}" readonly autocomplete="off" /><button class="button button-secondary" id="copy-tracking-token" type="button">Copy token</button></div><small class="tracking-token-warning">Treat this token like a password. Anyone with it can view this request.</small><p id="tracking-token-copy-feedback" role="status" aria-live="polite"></p></div>` : ""}
    <div class="confirmation-invoice-heading"><span>Invoice</span><strong>${escapeHtml(booking.number)}</strong></div>
    <div class="order-meta-row"><span>Package</span><strong>Up to ${escapeHtml(booking.packageSize)} pieces</strong></div>
    <div class="order-meta-row"><span>Service</span><strong>${escapeHtml(SERVICE_LABELS[booking.service])}</strong></div>
    <div class="order-meta-row"><span>Pickup location</span><strong>${escapeHtml(booking.address)}</strong></div>
    <div class="order-meta-row"><span>Pickup slot</span><strong>${escapeHtml(formatDate(booking.pickupDate))}, ${escapeHtml(formatSlot(booking.pickupSlot))}</strong></div>
    <div class="order-meta-row"><span>Expected ready</span><strong>${escapeHtml(booking.readyTime)}</strong></div>
    <div class="order-meta-row"><span>Pickup</span><strong>Included</strong></div>
    <div class="order-meta-row"><span>Delivery</span><strong>Included</strong></div>
    <div class="order-meta-row"><span>Included and extras</span><strong>${escapeHtml(extras.join(", ") || "Standard package")}</strong></div>
    <div class="order-meta-row"><span>Payment</span><strong>${escapeHtml(PAYMENT_LABELS[booking.paymentMethod] || "Cash or QR at pickup")}</strong></div>
    <div class="order-meta-row confirmation-total-row"><span>Total</span><strong>${formatMoney(Number(booking.total))}</strong></div>
  `;

  if (API_MODE) {
    document.querySelector("#copy-tracking-token").addEventListener("click", copyActiveTrackingToken);
  }
}

async function copyActiveTrackingToken() {
  const tokenInput = document.querySelector("#confirmation-tracking-token");
  const feedback = document.querySelector("#tracking-token-copy-feedback");
  try {
    await navigator.clipboard.writeText(activeTrackingToken);
    feedback.textContent = "Tracking token copied.";
  } catch {
    tokenInput.focus();
    tokenInput.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    feedback.textContent = copied
      ? "Tracking token copied."
      : "Select the token above and copy it to keep a private copy.";
  }
}

function renderTrackingResult(booking, apiResult = false) {
  const activeIndex = STATUS_STEPS.indexOf(booking.status);
  const cancelled = booking.status === STATUS_CANCELLED;
  trackingResult.hidden = false;
  trackingResult.innerHTML = `
    <div class="tracking-result">
      <h3>${escapeHtml(booking.number)}</h3>
      <div class="order-meta">
        <div class="order-meta-row"><span>Pickup</span><strong>${escapeHtml(formatDate(booking.pickupDate))}, ${escapeHtml(formatSlot(booking.pickupSlot))}</strong></div>
        <div class="order-meta-row"><span>Expected ready</span><strong>${escapeHtml(booking.readyTime)}</strong></div>
        <div class="order-meta-row"><span>Total</span><strong>${formatMoney(Number(booking.total))}</strong></div>
      </div>
      <p class="tracking-current-status ${cancelled ? "cancelled" : ""}"><strong>${apiResult ? "Staging API status:" : "Local status:"}</strong> ${escapeHtml(booking.status || STATUS_STEPS[0])}</p>
      ${cancelled ? "" : `<div class="status-timeline">
        ${STATUS_STEPS.map(
          (status, index) => `<div class="status-item ${index <= activeIndex ? "active" : ""}">${escapeHtml(status)}</div>`,
        ).join("")}
      </div>`}
      <p class="tracking-local-note">${apiResult ? "This staging status is not a live-service confirmation or customer notification." : "This status is a local demo update, not a customer notification."}</p>
    </div>
  `;
}

export function prepareTrackingView() {
  if (API_MODE) {
    trackingNumberInput.value = activeTrackingToken;
    return;
  }
  const latestBooking = readBookings().at(-1);
  if (latestBooking) {
    trackingNumberInput.value = latestBooking.number;
  }
}

async function trackApiRequest() {
  const token = trackingNumberInput.value.trim();
  const requestId = ++trackingRequestId;
  clearError(trackingError);
  trackingResult.hidden = true;

  if (!token) {
    showError(trackingError, "Enter your tracking token to continue.");
    return;
  }

  trackButton.disabled = true;
  try {
    const booking = await apiRequest(`/api/track/${encodeURIComponent(token)}`);
    if (requestId !== trackingRequestId) {
      return;
    }
    if (!booking || typeof booking.number !== "string") {
      throw new Error("The API returned an invalid tracking response. Try again.");
    }
    renderTrackingResult(booking, true);
  } catch (error) {
    if (requestId === trackingRequestId) {
      showError(trackingError, error.message || "The staging API could not load this request. Try again.");
    }
  } finally {
    if (requestId === trackingRequestId) {
      trackButton.disabled = false;
    }
  }
}

export function initializeTracking() {
  if (API_MODE) {
    trackingInputLabel.textContent = "Private tracking token";
    trackingNumberInput.placeholder = "Paste your tracking token";
    trackingIntro.textContent = "Use the private tracking token shown after a staging request. Treat it like a password; tracking uses the token, not the booking number.";
    trackButton.textContent = "Track staging request";
    trackButton.addEventListener("click", trackApiRequest);
    return;
  }

  trackButton.addEventListener("click", () => {
    const number = trackingNumberInput.value.trim().toUpperCase();
    const booking = readBookings().find((item) => item.number === number);
    clearError(trackingError);

    if (!number) {
      showError(trackingError, "Enter your booking number to continue.");
      trackingResult.hidden = true;
      return;
    }

    if (!booking) {
      showError(trackingError, "We could not find that booking number on this device yet.");
      trackingResult.hidden = true;
      return;
    }

    renderTrackingResult(booking);
  });
}
