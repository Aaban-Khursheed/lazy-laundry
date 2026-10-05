import { badgeVariants, buttonVariants } from "../../shared/variants.js";
import {
  PAYMENT_LABELS,
  PRICING,
  SERVICE_LABELS,
  STATUS_CANCELLED,
  STATUS_STEPS,
} from "./constants.js";
import { apiRequest } from "./api.js";
import { getTurnstileToken } from "./turnstile.js";
import {
  clearError,
  escapeHtml,
  formatDate,
  formatMoney,
  formatSlot,
  getMaxBookingDateString,
  getSlotsForDate,
  getTodayString,
  isSlotClosed,
  showError,
} from "./utils.js";

const trackingNumberInput = document.querySelector("#tracking-number");
const trackingTokenInput = document.querySelector("#tracking-token");
const trackingError = document.querySelector("#tracking-error");
const trackingResult = document.querySelector("#tracking-result");
const confirmationNumber = document.querySelector("#confirmation-number");
const confirmationDetails = document.querySelector("#confirmation-details");
const confirmationEyebrow = document.querySelector("#confirmation-view .eyebrow");
const confirmationHeading = document.querySelector("#confirmation-view h2");
const confirmationCopy = document.querySelector(".confirmation-copy");
const confirmationTrackButton = document.querySelector('#confirmation-view [data-view-target="tracking-view"]');
const trackButton = document.querySelector("#track-button");

let activeTrackingLink = "";
let trackingRequestId = 0;
let trackingBusy = false;
let activeRecord = null;
let statusRefresh = null;
let lookupController = null;
let availabilityController = null;
let availabilityRequestId = 0;
let rescheduleAvailability = null;
let verifiedPhone = "";
let pendingAction = null;
let pendingConfirmation = null;
const lockedNavigation = new Map();

export function isTrackingBusy() {
  return trackingBusy;
}

function updateTrackingControls() {
  [trackingNumberInput, trackingTokenInput, trackButton].forEach((control) => { control.disabled = trackingBusy; });
  trackingResult.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = trackingBusy || (control.id === "tracking-reschedule-slot" && !rescheduleAvailability?.ready) || (control.dataset.customerAction === "reschedule" && !rescheduleAvailability?.ready);
  });
  if (trackingBusy) {
    trackButton.setAttribute("aria-busy", "true");
    document.querySelectorAll("[data-view-target]").forEach((button) => {
      if (!lockedNavigation.has(button)) lockedNavigation.set(button, button.disabled);
      button.disabled = true;
    });
  } else {
    trackButton.removeAttribute("aria-busy");
    lockedNavigation.forEach((disabled, button) => { button.disabled = disabled; });
    lockedNavigation.clear();
  }
  document.dispatchEvent(new Event("customer-controls-changed"));
}

function invalidateTracking() {
  trackingRequestId += 1;
  availabilityRequestId += 1;
  lookupController?.abort();
  availabilityController?.abort();
  activeRecord = null;
  statusRefresh = null;
  rescheduleAvailability = null;
  verifiedPhone = "";
  pendingAction = null;
  pendingConfirmation = null;
  trackingResult.replaceChildren();
  trackingResult.hidden = true;
  clearError(trackingError);
}

function trackingErrorMessage(error) {
  if (error.status === 404) return "We could not find that booking. Check the number and private token.";
  if (error.status === 429) return "Too many tracking requests. Please wait a moment and try again.";
  return "Tracking status could not be loaded. Check your connection and retry. Your booking number and private token are preserved.";
}

function reportTrackingError(element, message) {
  showError(element, message);
  element.tabIndex = -1;
  element.focus({ preventScroll: false });
}

function validTrackedBooking(booking, credentials) {
  return booking?.number === credentials.number && /^\d{4}-\d{2}-\d{2}$/.test(booking.pickupDate) && getSlotsForDate(booking.pickupDate).includes(booking.pickupSlot) && typeof booking.status === "string" && typeof booking.total === "number" && Number.isFinite(booking.total) && typeof booking.canCancel === "boolean" && typeof booking.canReschedule === "boolean";
}

async function fetchTrackedBooking(credentials) {
  const controller = new AbortController();
  lookupController = controller;
  const booking = await apiRequest("/api/track", { method: "POST", readOnly: true, signal: controller.signal, body: credentials });
  if (!validTrackedBooking(booking, credentials)) throw new Error("The tracking response could not be verified.");
  return booking;
}

export function renderConfirmation(booking, trackingToken = "") {
  const extras = [
    booking.folding ? "Folding and packing" : null,
    booking.ironing ? "Ironing" : null,
    booking.hangers ? "Hangers" : null,
  ].filter(Boolean);
  const trackingLink = `${window.location.origin}/track#number=${encodeURIComponent(booking.number)}&token=${encodeURIComponent(trackingToken)}`;

  confirmationNumber.textContent = booking.number;
  confirmationEyebrow.textContent = "Booking confirmed";
  confirmationHeading.textContent = "Your pickup is reserved.";
  confirmationCopy.textContent = "Your booking was saved and the selected pickup slot is reserved. Keep your private tracking link safe.";
  confirmationTrackButton.textContent = "Track this booking";
  activeTrackingLink = trackingLink;
  prepareTrackingView(trackingToken, booking.number);

  confirmationDetails.innerHTML = `
    <div class="tracking-token-card">
      <label class="field-label" for="confirmation-tracking-token">Private tracking link</label>
      <div class="tracking-token-controls"><input class="text-input" id="confirmation-tracking-token" type="text" value="${escapeHtml(trackingLink)}" aria-label="Private tracking link" readonly autocomplete="off" autocapitalize="off" spellcheck="false" /><button class="${buttonVariants({ intent: "secondary", size: "md" })}" id="copy-tracking-token" type="button">Copy link</button></div>
      <small class="tracking-token-warning">Anyone with this link can view this booking. Keep it private.</small>
      <p id="tracking-token-copy-feedback" role="status" aria-live="polite"></p>
    </div>
    <div class="confirmation-invoice-heading"><span>Booking</span><strong>${escapeHtml(booking.number)}</strong></div>
    <div class="order-meta-row"><span>Package</span><strong>Up to ${escapeHtml(booking.packageSize)} pieces</strong></div>
    <div class="order-meta-row"><span>Service</span><strong>${escapeHtml(SERVICE_LABELS[booking.service])}</strong></div>
    <div class="order-meta-row"><span>Pickup area</span><strong>Edumetro, USJ 1</strong></div>
    <div class="order-meta-row"><span>Pickup slot</span><strong>${escapeHtml(formatDate(booking.pickupDate))}, ${escapeHtml(formatSlot(booking.pickupSlot))}</strong></div>
    <div class="order-meta-row"><span>Expected ready</span><strong>${escapeHtml(booking.readyTime)}</strong></div>
    <div class="order-meta-row"><span>Included and extras</span><strong>${escapeHtml(extras.join(", ") || "Standard package")}</strong></div>
    <div class="order-meta-row"><span>Payment</span><strong>${escapeHtml(PAYMENT_LABELS[booking.paymentMethod] || "Cash or QR at pickup")}</strong></div>
    <div class="order-meta-row confirmation-total-row"><span>Total</span><strong>${formatMoney(Number(booking.total))}</strong></div>
  `;
  document.querySelector("#copy-tracking-token").addEventListener("click", copyActiveTrackingLink);
}

async function copyActiveTrackingLink() {
  const linkInput = document.querySelector("#confirmation-tracking-token");
  const feedback = document.querySelector("#tracking-token-copy-feedback");
  try {
    await navigator.clipboard.writeText(activeTrackingLink);
    feedback.textContent = "Private tracking link copied.";
  } catch {
    linkInput.focus();
    linkInput.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    feedback.textContent = copied ? "Private tracking link copied." : "Select the link above and copy it to keep it private.";
  }
}

function dateInWindow(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= getTodayString() && date <= getMaxBookingDateString();
}

export function refreshTrackingWindow(reloadAvailability = false) {
  if (trackingBusy || !activeRecord) return;
  const input = trackingResult.querySelector("#tracking-reschedule-date");
  if (!input) return;
  const today = getTodayString();
  const maximum = getMaxBookingDateString();
  const changed = input.min !== today || input.max !== maximum;
  input.min = today;
  input.max = maximum;
  const invalid = !dateInWindow(input.value);
  if (invalid) input.value = today;
  if (changed || invalid || reloadAvailability) loadRescheduleAvailability(activeRecord);
}

function renderAvailabilityMessage(message, retry = false) {
  const container = trackingResult.querySelector("#tracking-reschedule-availability");
  if (!container) return;
  container.innerHTML = `<p class="tracking-local-note" role="status">${escapeHtml(message)}</p>${retry ? `<button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" id="tracking-availability-retry">Retry availability</button>` : ""}`;
  container.querySelector("button")?.addEventListener("click", () => refreshTrackingWindow(true));
}

async function loadRescheduleAvailability(context) {
  if (context !== activeRecord) return;
  const dateInput = trackingResult.querySelector("#tracking-reschedule-date");
  const slotInput = trackingResult.querySelector("#tracking-reschedule-slot");
  if (!dateInput || !slotInput) return;
  const date = dateInput.value;
  const selectedSlot = slotInput.value;
  const requestId = ++availabilityRequestId;
  availabilityController?.abort();
  const controller = new AbortController();
  availabilityController = controller;
  rescheduleAvailability = { date, ready: false, slots: [] };
  slotInput.replaceChildren();
  updateTrackingControls();
  if (!dateInWindow(date)) {
    renderAvailabilityMessage("Choose a date inside the current booking window.");
    return;
  }
  renderAvailabilityMessage("Loading pickup availability…");
  try {
    const result = await apiRequest(`/api/availability?date=${encodeURIComponent(date)}`, { readOnly: true, signal: controller.signal });
    if (requestId !== availabilityRequestId || context !== activeRecord || dateInput.value !== date) return;
    if (result?.date !== date || !Array.isArray(result.bookedSlots)) throw new Error("Pickup availability could not be verified.");
    if (!dateInWindow(date)) {
      dateInput.min = getTodayString();
      dateInput.max = getMaxBookingDateString();
      dateInput.value = getTodayString();
      loadRescheduleAvailability(context);
      return;
    }
    const slots = getSlotsForDate(date).filter((slot) => !isSlotClosed(date, slot) && (!result.bookedSlots.includes(slot) || (context.booking.pickupDate === date && context.booking.pickupSlot === slot)));
    rescheduleAvailability = { date, ready: slots.length > 0, slots };
    slotInput.innerHTML = slots.map((slot) => `<option value="${escapeHtml(slot)}">${escapeHtml(formatSlot(slot))}</option>`).join("");
    const preferred = selectedSlot || (context.booking.pickupDate === date ? context.booking.pickupSlot : "");
    if (slots.includes(preferred)) slotInput.value = preferred;
    renderAvailabilityMessage(slots.length ? "Only available pickup times are shown. Review your new time before rescheduling." : "No pickup times are available on this date. Choose another date or retry availability.", !slots.length);
  } catch (error) {
    if (requestId !== availabilityRequestId || context !== activeRecord || error.name === "AbortError") return;
    renderAvailabilityMessage("Pickup availability could not be loaded. Retry availability or choose another date. No reschedule has been submitted.", true);
  } finally {
    if (requestId === availabilityRequestId && context === activeRecord) updateTrackingControls();
  }
}

function renderTrackingResult(booking, credentials, phone = "") {
  availabilityController?.abort();
  availabilityRequestId += 1;
  rescheduleAvailability = null;
  verifiedPhone = "";
  pendingAction = null;
  pendingConfirmation = null;
  statusRefresh = null;
  const context = { booking, credentials: Object.freeze({ ...credentials }) };
  activeRecord = context;
  const activeIndex = STATUS_STEPS.indexOf(booking.status);
  const cancelled = booking.status === STATUS_CANCELLED;
  const today = getTodayString();
  const maxDate = getMaxBookingDateString();
  const rescheduleDate = dateInWindow(booking.pickupDate) ? booking.pickupDate : today;
  trackingResult.hidden = false;
  trackingResult.innerHTML = `
    <div class="tracking-result">
      <div class="tracking-result-heading"><p class="eyebrow">Your laundry journey</p><h3 tabindex="-1">${escapeHtml(booking.number)}</h3></div>
      <div class="order-meta">
        <div class="order-meta-row"><span>Pickup</span><strong>${escapeHtml(formatDate(booking.pickupDate))}, ${escapeHtml(formatSlot(booking.pickupSlot))}</strong></div>
        <div class="order-meta-row"><span>Expected ready</span><strong>${escapeHtml(booking.readyTime)}</strong></div>
        <div class="order-meta-row"><span>Total</span><strong>${formatMoney(Number(booking.total))}</strong></div>
      </div>
      <p class="tracking-current-status ${cancelled ? "cancelled" : ""}" role="status"><strong>Current status</strong><span class="${badgeVariants({ tone: cancelled ? "danger" : "info" })}">${escapeHtml(booking.status || STATUS_STEPS[0])}</span></p>
      ${cancelled ? `<p class="tracking-local-note">This booking is cancelled. Contact Lazy Laundry if you need help.</p>` : `<ol class="status-timeline" aria-label="Laundry progress">
        ${STATUS_STEPS.map((status, index) => `<li class="status-item ${index <= activeIndex ? "active" : ""}"${index === activeIndex ? ' aria-current="step"' : ""}>${escapeHtml(status)}</li>`).join("")}
      </ol>`}
      ${!cancelled && (booking.canCancel || booking.canReschedule || booking.canEdit) ? `<div class="tracking-actions">
        <h4>Manage this pickup</h4>
        <p class="tracking-local-note">${booking.cancellationLate ? "Cancellation is late and adds RM3; other changes are closed." : "Free cancellation and changes close 10 minutes before pickup."} The phone number on this booking is needed first.</p>
        <div class="tracking-action-buttons" id="tracking-action-menu">
          ${booking.canCancel ? `<button class="${buttonVariants({ intent: "danger", size: "md", width: "full" })}" type="button" data-customer-open="cancel">${booking.cancellationLate ? "Cancel with RM3 fee" : "Cancel booking"}</button>` : ""}
          ${booking.canReschedule ? `<button class="${buttonVariants({ intent: "primary", size: "md", width: "full" })}" type="button" data-customer-open="reschedule">Reschedule pickup</button>` : ""}
          ${booking.canEdit ? `<button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" data-customer-open="edit">Edit booking details</button>` : ""}
        </div>
        <div id="tracking-verify" hidden>
          <p class="tracking-local-note" id="tracking-verify-note"></p>
          <label class="field-label" for="tracking-action-phone">Booking phone number</label>
          <input class="text-input" id="tracking-action-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+60123456789" value="${escapeHtml(phone)}" />
          <button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" id="tracking-verify-continue">Continue</button>
        </div>
        ${booking.canReschedule ? `<div id="tracking-reschedule-panel" hidden>
          <label class="field-label" for="tracking-reschedule-date">New pickup date</label><input class="text-input" id="tracking-reschedule-date" type="date" min="${escapeHtml(today)}" max="${escapeHtml(maxDate)}" value="${escapeHtml(rescheduleDate)}" /><label class="field-label" for="tracking-reschedule-slot">New pickup time</label><select class="text-input" id="tracking-reschedule-slot" disabled></select><div id="tracking-reschedule-availability" aria-live="polite"></div>
          <button class="${buttonVariants({ intent: "primary", size: "md", width: "full" })}" type="button" data-customer-action="reschedule">Reschedule pickup</button>
        </div>` : ""}
        <div class="tracking-edit" id="tracking-edit-panel" hidden></div>
        <dialog class="tracking-confirm-dialog" id="tracking-confirm" aria-labelledby="tracking-confirm-title">
          <h4 class="tracking-confirm-title" id="tracking-confirm-title">Confirm</h4>
          <p class="tracking-local-note" id="tracking-confirm-note"></p>
          <div class="tracking-action-buttons">
            <button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" id="tracking-confirm-back">Back</button>
            <button class="${buttonVariants({ intent: "primary", size: "md", width: "full" })}" type="button" id="tracking-confirm-yes">Confirm</button>
          </div>
        </dialog>
        <div class="form-error" id="tracking-action-error" role="alert" hidden></div>
      </div>` : ""}
    </div>
  `;
  trackingResult.querySelectorAll("[data-customer-action]").forEach((button) => {
    button.addEventListener("click", () => handleCustomerAction(button.dataset.customerAction, context));
  });
  trackingResult.querySelectorAll("[data-customer-open]").forEach((button) => {
    button.addEventListener("click", () => openCustomerAction(context, button.dataset.customerOpen));
  });
  trackingResult.querySelector("#tracking-verify-continue")?.addEventListener("click", () => continueCustomerVerification(context));
  const confirmDialog = trackingResult.querySelector("#tracking-confirm");
  confirmDialog?.querySelector("#tracking-confirm-yes")?.addEventListener("click", () => {
    const action = pendingConfirmation;
    confirmDialog.close();
    if (action) handleCustomerAction(action, context, { confirmed: true });
  });
  confirmDialog?.querySelector("#tracking-confirm-back")?.addEventListener("click", () => confirmDialog.close());
  confirmDialog?.addEventListener("close", () => { pendingConfirmation = null; });
  trackingResult.querySelector("#tracking-action-phone")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); continueCustomerVerification(context); }
  });
  const rescheduleDateInput = trackingResult.querySelector("#tracking-reschedule-date");
  const dateChanged = () => { if (!trackingBusy && context === activeRecord) loadRescheduleAvailability(context); };
  rescheduleDateInput?.addEventListener("input", dateChanged);
  rescheduleDateInput?.addEventListener("change", dateChanged);
  updateTrackingControls();
  trackingResult.querySelector("h3")?.focus({ preventScroll: true });
}

function offerStatusRefresh(context, booking, message, phone = "") {
  renderTrackingResult({ ...booking, canCancel: false, canReschedule: false }, context.credentials);
  statusRefresh = { credentials: context.credentials, booking, message, phone };
  const notice = document.createElement("div");
  notice.className = "tracking-actions";
  notice.innerHTML = `<p class="tracking-local-note" role="status">${escapeHtml(message)}</p><button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" id="tracking-refresh-status">Refresh status</button>`;
  trackingResult.appendChild(notice);
  notice.querySelector("button").addEventListener("click", refreshStatus);
  updateTrackingControls();
}

async function refreshStatus() {
  if (trackingBusy || !statusRefresh) return;
  const recovery = statusRefresh;
  const requestId = trackingRequestId;
  trackingBusy = true;
  updateTrackingControls();
  clearError(trackingError);
  try {
    const booking = await fetchTrackedBooking(recovery.credentials);
    if (requestId !== trackingRequestId || statusRefresh !== recovery) return;
    renderTrackingResult(booking, recovery.credentials, recovery.phone);
  } catch (error) {
    if (requestId === trackingRequestId) reportTrackingError(trackingError, `${recovery.message} ${trackingErrorMessage(error)}`);
  } finally {
    trackingBusy = false;
    updateTrackingControls();
  }
}

const EDIT_BLOCK_OPTIONS = ["Block A/B", "Block C", "Block E", "Colonial"];

function actionError() {
  return trackingResult.querySelector("#tracking-action-error");
}

function openCustomerAction(context, action) {
  if (trackingBusy || context !== activeRecord || statusRefresh) return;
  const booking = context.booking;
  if (action === "cancel" && !booking.canCancel || action === "reschedule" && !booking.canReschedule || action === "edit" && !booking.canEdit) return;
  clearError(actionError());
  if (verifiedPhone) {
    revealCustomerAction(context, action);
    return;
  }
  pendingAction = action;
  const verify = trackingResult.querySelector("#tracking-verify");
  const note = trackingResult.querySelector("#tracking-verify-note");
  if (note) {
    note.textContent = action === "edit"
      ? "Enter the phone number used for this booking to open editing."
      : action === "reschedule" ? "Enter the phone number used for this booking to choose a new pickup time." : "Enter the phone number used for this booking to cancel it.";
  }
  if (verify) {
    verify.hidden = false;
    trackingResult.querySelector("#tracking-reschedule-panel").hidden = true;
    trackingResult.querySelector("#tracking-edit-panel").hidden = true;
    const input = trackingResult.querySelector("#tracking-action-phone");
    input?.focus();
  }
}

function continueCustomerVerification(context) {
  if (trackingBusy || context !== activeRecord || statusRefresh || !pendingAction) return;
  const input = trackingResult.querySelector("#tracking-action-phone");
  const phone = input?.value.trim() || "";
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    reportTrackingError(actionError(), "Enter the full phone number used for this booking.");
    input?.focus();
    return;
  }
  clearError(actionError());
  verifiedPhone = phone;
  const action = pendingAction;
  pendingAction = null;
  const verify = trackingResult.querySelector("#tracking-verify");
  if (verify) verify.hidden = true;
  revealCustomerAction(context, action);
}

function revealCustomerAction(context, action) {
  if (context !== activeRecord) return;
  if (action === "edit") {
    openCustomerEdit(context);
  } else if (action === "reschedule") {
    const panel = trackingResult.querySelector("#tracking-reschedule-panel");
    if (!panel) return;
    panel.hidden = false;
    trackingResult.querySelector("#tracking-edit-panel").hidden = true;
    loadRescheduleAvailability(context);
    trackingResult.querySelector("#tracking-reschedule-date")?.focus();
  } else if (action === "cancel") {
    handleCustomerAction("cancel", context);
  }
}

function editTotalCents(packageSize, service, hangers) {
  const tier = PRICING[Number(packageSize)];
  if (!tier) return null;
  return Math.round((tier.base + (service === "express" ? tier.express : 0) + (hangers === true ? tier.hanger : 0)) * 100);
}

function updateEditTotal(panel, original) {
  const total = panel.querySelector("#tracking-edit-total");
  if (!total) return;
  const cents = editTotalCents(panel.querySelector("#tracking-edit-package")?.value, panel.querySelector("#tracking-edit-service")?.value, panel.querySelector("#tracking-edit-hangers")?.checked);
  if (cents === null) { total.textContent = ""; return; }
  const next = cents / 100 + Number(original.feeTotal || 0);
  total.textContent = Math.abs(next - Number(original.total)) > 0.001
    ? `New total ${formatMoney(next)} — was ${formatMoney(Number(original.total))}. The updated price is collected at pickup.`
    : `Total ${formatMoney(next)} — unchanged.`;
}

function renderEditPanel(context, edit) {
  const panel = trackingResult.querySelector("#tracking-edit-panel");
  if (!panel) return;
  context.editBaseline = edit;
  panel.hidden = false;
  panel.innerHTML = `
    <h4 id="tracking-edit-title">Edit booking details</h4>
    <div class="order-meta tracking-edit-summary">
      <div class="order-meta-row"><span>Booking</span><strong>${escapeHtml(edit.number)}</strong></div>
      <div class="order-meta-row"><span>Pickup</span><strong>${escapeHtml(formatDate(edit.pickupDate))}, ${escapeHtml(formatSlot(edit.pickupSlot))}</strong></div>
      <div class="order-meta-row"><span>Expected ready</span><strong>${escapeHtml(edit.readyTime)}</strong></div>
      <div class="order-meta-row"><span>Status</span><strong>${escapeHtml(edit.status)}</strong></div>
      <div class="order-meta-row"><span>Service area</span><strong>Edumetro, USJ 1</strong></div>
    </div>
    <p class="tracking-local-note">Save applies immediately and is recorded. Use Reschedule for a different pickup time.</p>
    <label class="field-label" for="tracking-edit-name">Customer name</label>
    <input class="text-input" id="tracking-edit-name" maxlength="120" autocomplete="name" value="${escapeHtml(edit.name || "")}" />
    <label class="field-label" for="tracking-edit-block">Block / building</label>
    <select class="text-input" id="tracking-edit-block">${EDIT_BLOCK_OPTIONS.map((block) => `<option value="${block}"${block === edit.block ? " selected" : ""}>${block}</option>`).join("")}</select>
    <label class="field-label" for="tracking-edit-unit">Unit number</label>
    <input class="text-input" id="tracking-edit-unit" maxlength="12" autocomplete="off" placeholder="e.g. A-12-03" value="${escapeHtml(edit.unit || "")}" />
    <label class="field-label" for="tracking-edit-package">Package</label>
    <select class="text-input" id="tracking-edit-package">${[10, 18].map((size) => `<option value="${size}"${size === edit.packageSize ? " selected" : ""}>${size} pieces</option>`).join("")}</select>
    <label class="field-label" for="tracking-edit-service">Service</label>
    <select class="text-input" id="tracking-edit-service">${Object.entries(SERVICE_LABELS).map(([value, label]) => `<option value="${value}"${value === edit.service ? " selected" : ""}>${label}</option>`).join("")}</select>
    <fieldset class="tracking-edit-finish"><legend>Finish</legend>
      <label class="tracking-edit-check"><input type="checkbox" id="tracking-edit-folding"${edit.folding !== false ? " checked" : ""} /> Folded</label>
      <label class="tracking-edit-check"><input type="checkbox" id="tracking-edit-ironing"${edit.ironing !== false ? " checked" : ""} /> Ironed</label>
      <label class="tracking-edit-check"><input type="checkbox" id="tracking-edit-hangers"${edit.hangers === true ? " checked" : ""} /> On hangers</label>
    </fieldset>
    <label class="field-label" for="tracking-edit-payment">Payment method</label>
    <select class="text-input" id="tracking-edit-payment">${Object.entries(PAYMENT_LABELS).map(([value, label]) => `<option value="${value}"${value === edit.paymentMethod ? " selected" : ""}>${label}</option>`).join("")}</select>
    <p class="tracking-edit-total" id="tracking-edit-total" role="status"></p>
    <div class="tracking-action-buttons">
      <button class="${buttonVariants({ intent: "secondary", size: "md", width: "full" })}" type="button" id="tracking-edit-close">Cancel</button>
      <button class="${buttonVariants({ intent: "primary", size: "md", width: "full" })}" type="button" data-customer-action="edit">Save changes</button>
    </div>
    <div class="form-error" id="tracking-edit-error" role="alert" hidden></div>
  `;
  updateEditTotal(panel, edit);
  ["#tracking-edit-package", "#tracking-edit-service", "#tracking-edit-hangers"].forEach((selector) => panel.querySelector(selector)?.addEventListener("change", () => updateEditTotal(panel, edit)));
  panel.querySelector("#tracking-edit-close")?.addEventListener("click", () => { panel.hidden = true; panel.innerHTML = ""; });
  panel.querySelector('[data-customer-action="edit"]')?.addEventListener("click", () => handleCustomerAction("edit", context));
  updateTrackingControls();
  panel.querySelector("#tracking-edit-name")?.focus();
}

async function openCustomerEdit(context) {
  if (trackingBusy || context !== activeRecord || statusRefresh || !verifiedPhone) return;
  const errorEl = actionError();
  trackingBusy = true;
  updateTrackingControls();
  clearError(errorEl);
  const requestId = trackingRequestId;
  try {
    const turnstileToken = await getTurnstileToken("edit");
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    const result = await apiRequest(`/api/bookings/${encodeURIComponent(context.credentials.number)}/edit`, {
      method: "POST",
      headers: turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {},
      body: { ...context.credentials, phone: verifiedPhone },
    });
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    if (!result?.booking || result.booking.number !== context.credentials.number) {
      reportTrackingError(errorEl, "The booking details could not be loaded. Please try again.");
      return;
    }
    if (result.booking.canEdit === false) {
      reportTrackingError(errorEl, result.booking.editLate ? "Editing is closed because pickup is about to start." : "This booking can no longer be edited.");
      return;
    }
    renderEditPanel(context, result.booking);
  } catch (error) {
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    if (error.status === 404) {
      verifiedPhone = "";
      reportTrackingError(errorEl, "We could not verify this booking and phone number. Check the details and try again.");
    } else {
      reportTrackingError(errorEl, error.message || "The booking details could not be loaded. Please try again.");
    }
  } finally {
    trackingBusy = false;
    updateTrackingControls();
  }
}

function customerEditSummary(values, baseline) {
  const fmt = (key, value) => key === "packageSize" ? `${value} pieces`
    : key === "service" ? SERVICE_LABELS[value] || value
    : key === "paymentMethod" ? PAYMENT_LABELS[value] || value
    : String(value);
  const labels = { name: "Name", block: "Block", unit: "Unit", packageSize: "Package", service: "Service", paymentMethod: "Payment" };
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    if (String(values[key] ?? "") !== String(baseline?.[key] ?? "")) parts.push(`${label}: ${fmt(key, baseline?.[key])} → ${fmt(key, values[key])}`);
  }
  if (["folding", "ironing", "hangers"].some((key) => values[key] !== baseline?.[key])) parts.push("Finish options updated");
  const cents = editTotalCents(values.packageSize, values.service, values.hangers);
  if (cents !== null) {
    const next = cents / 100 + Number(baseline?.feeTotal || 0);
    if (Math.abs(next - Number(baseline?.total)) > 0.001) parts.push(`Total ${formatMoney(Number(baseline.total))} → ${formatMoney(next)}`);
  }
  return parts.join(" · ");
}

function requestCustomerConfirmation(context, action, note) {
  pendingConfirmation = action;
  const dialog = trackingResult.querySelector("#tracking-confirm");
  const titleEl = trackingResult.querySelector("#tracking-confirm-title");
  const noteEl = trackingResult.querySelector("#tracking-confirm-note");
  const yes = trackingResult.querySelector("#tracking-confirm-yes");
  if (titleEl) titleEl.textContent = action === "cancel" ? "Cancel booking?" : action === "reschedule" ? "Confirm new pickup?" : "Save changes?";
  if (noteEl) noteEl.textContent = note;
  if (yes) yes.className = buttonVariants({ intent: action === "cancel" ? "danger" : "primary", size: "md", width: "full" });
  dialog?.showModal();
}

async function handleCustomerAction(action, context, { confirmed = false } = {}) {
  if (trackingBusy || context !== activeRecord || statusRefresh) return;
  const booking = context.booking;
  if (action === "cancel" && !booking.canCancel || action === "reschedule" && !booking.canReschedule || action === "edit" && !booking.canEdit) return;
  const phoneInput = trackingResult.querySelector("#tracking-action-phone");
  const phone = verifiedPhone || phoneInput?.value.trim() || "";
  const actionError = trackingResult.querySelector(action === "edit" ? "#tracking-edit-error" : "#tracking-action-error") || trackingResult.querySelector("#tracking-action-error");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    verifiedPhone = "";
    reportTrackingError(actionError, "Enter the full phone number used for this booking.");
    openCustomerAction(context, action);
    return;
  }
  const body = { ...context.credentials, phone };
  if (action === "edit") {
    const panel = trackingResult.querySelector("#tracking-edit-panel");
    const name = panel?.querySelector("#tracking-edit-name")?.value.trim() || "";
    const block = panel?.querySelector("#tracking-edit-block")?.value || "";
    const unit = panel?.querySelector("#tracking-edit-unit")?.value.trim() || "";
    const unitPrefixes = { "Block A/B": ["A", "B"], "Block C": ["C"], "Block E": ["E"], Colonial: ["C"] };
    if (!name || name.length > 120 || !/^[A-Z]-\d{1,2}-\d{1,3}$/i.test(unit) || !unitPrefixes[block]?.includes(unit.slice(0, 1).toUpperCase())) {
      reportTrackingError(actionError, "Check the name, block and unit number — units look like A-12-03 and must match the block.");
      return;
    }
    body.fields = {
      name, block, unit,
      packageSize: Number(panel.querySelector("#tracking-edit-package")?.value),
      service: panel.querySelector("#tracking-edit-service")?.value,
      folding: panel.querySelector("#tracking-edit-folding")?.checked === true,
      ironing: panel.querySelector("#tracking-edit-ironing")?.checked === true,
      hangers: panel.querySelector("#tracking-edit-hangers")?.checked === true,
      paymentMethod: panel.querySelector("#tracking-edit-payment")?.value,
    };
  }
  if (action === "reschedule") {
    body.pickupDate = trackingResult.querySelector("#tracking-reschedule-date")?.value || "";
    body.pickupSlot = trackingResult.querySelector("#tracking-reschedule-slot")?.value || "";
    if (!dateInWindow(body.pickupDate)) {
      refreshTrackingWindow();
      reportTrackingError(actionError, "The pickup date is outside the current booking window. Choose a new available time.");
      return;
    }
    if (!rescheduleAvailability?.ready || rescheduleAvailability.date !== body.pickupDate || !rescheduleAvailability.slots.includes(body.pickupSlot) || isSlotClosed(body.pickupDate, body.pickupSlot)) {
      loadRescheduleAvailability(context);
      reportTrackingError(actionError, "Choose a currently available pickup time after availability finishes loading.");
      return;
    }
  }
  let editSummary = "";
  if (action === "edit" && body.fields) {
    editSummary = customerEditSummary(body.fields, context.editBaseline);
    if (!editSummary) {
      reportTrackingError(actionError, "Nothing has changed to save.");
      return;
    }
  }
  if (!confirmed) {
    requestCustomerConfirmation(context, action,
      action === "cancel"
        ? `Cancel booking ${booking.number}?${booking.cancellationLate ? " A RM3 late-cancellation fee applies." : ""} This cannot be undone.`
        : action === "reschedule"
          ? `Move the pickup to ${formatDate(body.pickupDate)}, ${formatSlot(body.pickupSlot)} MYT?`
          : `Save these changes? ${editSummary}`);
    return;
  }
  pendingConfirmation = null;
  trackingBusy = true;
  updateTrackingControls();
  clearError(actionError);
  const requestId = trackingRequestId;
  let sent = false;
  let succeeded = false;
  let refreshChoices = false;
  try {
    const turnstileToken = await getTurnstileToken(action);
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    if (action === "reschedule" && (!dateInWindow(body.pickupDate) || isSlotClosed(body.pickupDate, body.pickupSlot) || trackingResult.querySelector("#tracking-reschedule-date")?.value !== body.pickupDate || trackingResult.querySelector("#tracking-reschedule-slot")?.value !== body.pickupSlot)) {
      refreshChoices = true;
      throw new Error("The selected pickup time changed or expired during verification. Review refreshed availability before rescheduling.");
    }
    sent = true;
    const result = await apiRequest(`/api/bookings/${encodeURIComponent(context.credentials.number)}/${action}`, {
      method: "POST",
      headers: turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {},
      body,
    });
    succeeded = true;
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    if (!result?.booking || result.booking.number !== context.credentials.number) {
      offerStatusRefresh(context, booking, "The server accepted the update, but its confirmation could not be verified. Refresh status before making another change.", phone);
      return;
    }
    const updated = { ...booking, ...result.booking };
    if (action === "cancel") {
      renderTrackingResult({ ...updated, status: STATUS_CANCELLED, canCancel: false, canReschedule: false, canEdit: false }, context.credentials);
      return;
    }
    try {
      const fresh = await fetchTrackedBooking(context.credentials);
      if (requestId !== trackingRequestId || context !== activeRecord) return;
      renderTrackingResult(fresh, context.credentials, phone);
    } catch {
      if (requestId === trackingRequestId && context === activeRecord) offerStatusRefresh(context, updated, "Your pickup change was saved. Fresh status could not be loaded. Refresh status before making another change; do not repeat the reschedule.", phone);
    }
  } catch (error) {
    if (requestId !== trackingRequestId || context !== activeRecord) return;
    if (succeeded || sent && (error.outcomeUnknown || !error.status)) {
      offerStatusRefresh(context, booking, "The update confirmation could not be verified. It may already be saved. Refresh status before making another change; do not repeat the update.", phone);
    } else {
      if (error.status === 404) verifiedPhone = "";
      reportTrackingError(actionError, error.status === 404 ? "We could not verify this booking and phone number. Check the details and try again." : error.message || "The booking update could not be saved. Please try again.");
      if (error.status === 409 && action === "reschedule") {
        loadRescheduleAvailability(context);
        reportTrackingError(actionError, "The booking or pickup availability changed. Choices are being refreshed; review an available time before trying again.");
      }
    }
  } finally {
    trackingBusy = false;
    updateTrackingControls();
    if (refreshChoices && context === activeRecord) refreshTrackingWindow(true);
  }
}

export function prepareTrackingView(token = "", number = "") {
  if (trackingBusy) return;
  if ((number && number.toUpperCase() !== trackingNumberInput.value) || (token && token !== trackingTokenInput.value)) invalidateTracking();
  if (number) trackingNumberInput.value = number.toUpperCase();
  if (token) trackingTokenInput.value = token;
  refreshTrackingWindow();
}

async function trackApiRequest() {
  if (trackingBusy) return;
  const credentials = Object.freeze({ number: trackingNumberInput.value.trim().toUpperCase(), token: trackingTokenInput.value.trim() });
  invalidateTracking();
  const requestId = trackingRequestId;
  if (!/^LL-[A-F0-9]{8}$/.test(credentials.number) || !credentials.token) {
    reportTrackingError(trackingError, "Enter your booking number and private tracking token to continue.");
    (!/^LL-[A-F0-9]{8}$/.test(credentials.number) ? trackingNumberInput : trackingTokenInput).focus();
    return;
  }
  trackingBusy = true;
  updateTrackingControls();
  try {
    const booking = await fetchTrackedBooking(credentials);
    if (requestId !== trackingRequestId) return;
    renderTrackingResult(booking, credentials);
  } catch (error) {
    if (requestId === trackingRequestId && error.name !== "AbortError") reportTrackingError(trackingError, trackingErrorMessage(error));
  } finally {
    trackingBusy = false;
    updateTrackingControls();
  }
}

export function initializeTracking() {
  trackButton.addEventListener("click", trackApiRequest);
  [trackingNumberInput, trackingTokenInput].forEach((input) => {
    input.addEventListener("input", invalidateTracking);
    input.addEventListener("change", invalidateTracking);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); trackApiRequest(); }
    });
  });
  window.addEventListener("focus", () => refreshTrackingWindow());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTrackingWindow(); });
}
