import {
  PAYMENT_LABELS,
  SERVICE_LABELS,
  STATUS_ACTIONS,
  STATUS_CANCELLED,
  STATUS_STEPS,
} from "./constants.js";
import { API_MODE, apiRequest } from "./api.js";
import {
  clearError,
  escapeHtml,
  formatAdminTimestamp,
  formatDate,
  formatMoney,
  formatSlot,
  getStatusClass,
  getStatusHistory,
  readBookings,
  showError,
  updateBooking,
} from "./utils.js";

const operatorBookingList = document.querySelector("#operator-booking-list");
const operatorEmpty = document.querySelector("#operator-empty");
const operatorDetail = document.querySelector("#operator-detail");
const operatorFeedback = document.querySelector("#operator-feedback");
const operatorFilter = document.querySelector("#operator-filter");
const operatorPendingCount = document.querySelector("#operator-pending-count");
const operatorActiveCount = document.querySelector("#operator-active-count");
const operatorUnpaidCount = document.querySelector("#operator-unpaid-count");

let listRequestId = 0;
let detailRequestId = 0;
let showingApiDetail = false;

function filterBookings(bookings) {
  const filter = operatorFilter.value;
  const filtered = bookings.filter((booking) => {
    if (filter === "pending") return booking.status === STATUS_STEPS[0];
    if (filter === "active") return booking.status !== STATUS_STEPS[0] && booking.status !== "Delivered" && booking.status !== STATUS_CANCELLED;
    if (filter === "completed") return booking.status === "Delivered";
    if (filter === "cancelled") return booking.status === STATUS_CANCELLED;
    return true;
  });
  return filtered.sort((left, right) => `${left.pickupDate || ""}T${left.pickupSlot || ""}`.localeCompare(`${right.pickupDate || ""}T${right.pickupSlot || ""}`));
}

function getLocalOperatorBookings() {
  return filterBookings(readBookings());
}

function renderLocalOperatorDashboard() {
  const bookings = readBookings();
  operatorPendingCount.textContent = String(bookings.filter((booking) => booking.status === STATUS_STEPS[0]).length);
  operatorActiveCount.textContent = String(bookings.filter((booking) => booking.status !== STATUS_STEPS[0] && booking.status !== "Delivered" && booking.status !== STATUS_CANCELLED).length);
  operatorUnpaidCount.textContent = String(bookings.filter((booking) => booking.status !== STATUS_CANCELLED && booking.paymentStatus !== "paid").length);
  operatorBookingList.hidden = false;
  operatorDetail.hidden = true;
  operatorEmpty.hidden = true;
  clearError(operatorFeedback);

  const filteredBookings = getLocalOperatorBookings();
  operatorBookingList.innerHTML = filteredBookings.map((booking) => `
    <button class="admin-booking-card" type="button" data-booking-number="${escapeHtml(booking.number || "")}">
      <span class="admin-booking-topline"><strong>${escapeHtml(booking.number || "No booking number")}</strong><span class="admin-status-badge ${getStatusClass(booking.status || STATUS_STEPS[0])}">${escapeHtml(booking.status || STATUS_STEPS[0])}</span></span>
      <span class="admin-booking-name">${escapeHtml(booking.name || "Unnamed request")}</span>
      <span class="admin-booking-meta">${escapeHtml(booking.pickupDate ? formatDate(booking.pickupDate) : "Pickup date unavailable")}${booking.pickupSlot ? ` · ${escapeHtml(formatSlot(booking.pickupSlot))}` : ""}</span>
      <span class="admin-booking-bottomline"><span>${escapeHtml(booking.packageSize ? `${booking.packageSize}-piece package` : "Package unavailable")}</span><strong>${formatMoney(Number(booking.total) || 0)}</strong></span>
    </button>
  `).join("");
  operatorEmpty.hidden = filteredBookings.length > 0;
  operatorBookingList.querySelectorAll("[data-booking-number]").forEach((button) => {
    button.addEventListener("click", () => renderOperatorDetail(button.dataset.bookingNumber));
  });
}

async function renderApiOperatorDashboard() {
  const requestId = ++listRequestId;
  showingApiDetail = false;
  detailRequestId += 1;
  operatorBookingList.hidden = false;
  operatorDetail.hidden = true;
  operatorEmpty.hidden = true;
  operatorBookingList.innerHTML = '<p class="admin-loading-message" role="status">Loading bookings…</p>';
  operatorPendingCount.textContent = "—";
  operatorActiveCount.textContent = "—";
  operatorUnpaidCount.textContent = "—";
  clearError(operatorFeedback);

  try {
    const result = await apiRequest("/api/operator/bookings?status=all&limit=50", { credentials: "include" });
    if (requestId !== listRequestId || showingApiDetail) {
      return;
    }
    if (!Array.isArray(result?.bookings) || result.bookings.some((booking) => !booking || typeof booking.id !== "string")) {
      throw new Error("The operator API returned an invalid bookings response.");
    }

    const bookings = result.bookings;
    const summary = result.summary;
    operatorPendingCount.textContent = String(Number.isFinite(summary?.pending) ? summary.pending : bookings.filter((booking) => booking.status === STATUS_STEPS[0]).length);
    operatorActiveCount.textContent = String(Number.isFinite(summary?.active) ? summary.active : bookings.filter((booking) => booking.status !== STATUS_STEPS[0] && booking.status !== "Delivered" && booking.status !== STATUS_CANCELLED).length);
    operatorUnpaidCount.textContent = String(Number.isFinite(summary?.unpaid) ? summary.unpaid : bookings.filter((booking) => booking.status !== STATUS_CANCELLED && booking.paymentStatus !== "paid").length);
    const filteredBookings = filterBookings(bookings);
    operatorBookingList.innerHTML = filteredBookings.map((booking) => `
      <button class="admin-booking-card" type="button" data-booking-id="${escapeHtml(booking.id)}">
        <span class="admin-booking-topline"><strong>${escapeHtml(booking.number || "No booking number")}</strong><span class="admin-status-badge ${getStatusClass(booking.status || STATUS_STEPS[0])}">${escapeHtml(booking.status || STATUS_STEPS[0])}</span></span>
        <span class="admin-booking-name">${escapeHtml(booking.name || "Unnamed request")}</span>
        <span class="admin-booking-meta">${escapeHtml(booking.pickupDate ? formatDate(booking.pickupDate) : "Pickup date unavailable")}${booking.pickupSlot ? ` · ${escapeHtml(formatSlot(booking.pickupSlot))}` : ""}</span>
        <span class="admin-booking-bottomline"><span>${escapeHtml(booking.packageSize ? `${booking.packageSize}-piece package` : "Package unavailable")}</span><strong>${formatMoney(Number(booking.total) || 0)}</strong></span>
      </button>
    `).join("");
    operatorEmpty.hidden = filteredBookings.length > 0;
    operatorBookingList.querySelectorAll("[data-booking-id]").forEach((button) => {
      button.addEventListener("click", () => renderOperatorDetail(button.dataset.bookingId));
    });
  } catch (error) {
    if (requestId === listRequestId && !showingApiDetail) {
      operatorBookingList.innerHTML = "";
      operatorEmpty.hidden = true;
      showError(operatorFeedback, error.message || "The operator API could not load bookings.");
    }
  }
}

export function renderOperatorDashboard() {
  if (API_MODE) {
    return renderApiOperatorDashboard();
  }
  return renderLocalOperatorDashboard();
}

function renderOperatorDetailView(booking, apiMode = false) {
  const currentIndex = STATUS_STEPS.indexOf(booking.status);
  const nextStatus = currentIndex >= 0 ? STATUS_STEPS[currentIndex + 1] : null;
  const canCancel = currentIndex >= 0 && currentIndex < STATUS_STEPS.indexOf("Laundry picked up");
  const history = getStatusHistory(booking, STATUS_STEPS);
  const pickup = booking.pickupDate && booking.pickupSlot
    ? `${formatDate(booking.pickupDate)}, ${formatSlot(booking.pickupSlot)}`
    : "Not recorded";
  const address = booking.address || [booking.block, booking.unit].filter(Boolean).join(", ") || "Not recorded";
  const bookingIdentifier = apiMode ? booking.id : booking.number;
  const identifierAttribute = apiMode ? "data-booking-id" : "data-booking-number";
  const confirmationText = apiMode
    ? "Cancel this staging request? This cannot be undone."
    : "Cancel this request? This cannot be undone in the demo.";

  operatorBookingList.hidden = true;
  operatorEmpty.hidden = true;
  operatorDetail.hidden = false;
  clearError(operatorFeedback);
  operatorDetail.innerHTML = `
    <button class="admin-back-list" type="button" id="operator-back-list">← Back to bookings</button>
    <div class="admin-detail-heading">
      <div><span class="admin-detail-kicker">${escapeHtml(booking.number || "Booking")}</span><h3 id="operator-detail-title">${escapeHtml(booking.name || "Unnamed request")}</h3></div>
      <span class="admin-status-badge ${getStatusClass(booking.status || STATUS_STEPS[0])}">${escapeHtml(booking.status || STATUS_STEPS[0])}</span>
    </div>
    <div class="admin-detail-grid">
      <div><span>Phone</span><strong>${escapeHtml(booking.phone || "Not recorded")}</strong></div>
      <div><span>Pickup location</span><strong>${escapeHtml(address)}</strong></div>
      <div><span>Pickup slot</span><strong>${escapeHtml(pickup)}</strong></div>
      <div><span>Package / service</span><strong>${escapeHtml(`${booking.packageSize || "?"} pieces · ${SERVICE_LABELS[booking.service] || "Service not recorded"}`)}</strong></div>
      <div><span>Expected ready</span><strong>${escapeHtml(booking.readyTime || "Not recorded")}</strong></div>
      <div><span>Order total</span><strong>${formatMoney(Number(booking.total) || 0)}</strong></div>
      <div><span>Payment method</span><strong>${escapeHtml(PAYMENT_LABELS[booking.paymentMethod] || "Not recorded")}</strong></div>
      <div><span>Payment status</span><strong>${booking.paymentStatus === "paid" ? `Collected ${booking.paidAt ? `· ${escapeHtml(formatAdminTimestamp(booking.paidAt))}` : ""}` : "Due"}</strong></div>
    </div>
    <div class="admin-action-section">
      <div class="admin-section-heading"><h4>Next action</h4><span>Status advances in order</span></div>
      <div class="admin-status-actions">
        ${nextStatus ? `<button class="admin-status-button" type="button" data-operator-action="advance" ${identifierAttribute}="${escapeHtml(bookingIdentifier)}">${escapeHtml(STATUS_ACTIONS[nextStatus])}</button>` : `<p class="admin-action-note">${booking.status === STATUS_CANCELLED ? "This request is cancelled." : "This order is complete."}</p>`}
        ${canCancel ? `<button class="admin-status-button admin-cancel-button" type="button" data-operator-action="cancel" ${identifierAttribute}="${escapeHtml(bookingIdentifier)}">Cancel request</button>` : ""}
      </div>
      ${booking.paymentStatus === "paid" || booking.status === STATUS_CANCELLED ? "" : `<div class="admin-payment-row"><button class="button button-secondary admin-paid-button" type="button" data-operator-action="paid" ${identifierAttribute}="${escapeHtml(bookingIdentifier)}">Mark payment collected</button></div>`}
    </div>
    <div class="admin-action-section">
      <div class="admin-section-heading"><h4>Status history</h4><span>${history.length} update${history.length === 1 ? "" : "s"}</span></div>
      <div class="admin-history">${history.map((entry) => `<div class="admin-history-item"><span class="admin-history-dot" aria-hidden="true"></span><div><strong>${escapeHtml(entry.status)}</strong><small>${escapeHtml(formatAdminTimestamp(entry.at))}</small></div></div>`).join("")}</div>
    </div>
  `;

  operatorDetail.querySelector("#operator-back-list").addEventListener("click", renderOperatorDashboard);
  operatorDetail.querySelectorAll("[data-operator-action]").forEach((button) => {
    button.addEventListener("click", () => handleOperatorAction(
      button.dataset.operatorAction,
      apiMode ? button.dataset.bookingId : button.dataset.bookingNumber,
    ));
  });
  if (!apiMode) {
    const cancelButtons = operatorDetail.querySelectorAll('[data-operator-action="cancel"]');
    cancelButtons.forEach((button) => button.setAttribute("data-cancel-confirmation", confirmationText));
  }
}

async function renderApiOperatorDetail(id) {
  const requestId = ++detailRequestId;
  showingApiDetail = true;
  listRequestId += 1;
  operatorBookingList.hidden = true;
  operatorEmpty.hidden = true;
  operatorDetail.hidden = false;
  operatorDetail.textContent = "Loading booking…";
  clearError(operatorFeedback);

  try {
    const result = await apiRequest(`/api/operator/bookings/${encodeURIComponent(id)}`, { credentials: "include" });
    if (requestId !== detailRequestId || !showingApiDetail) {
      return;
    }
    if (!result?.booking || typeof result.booking.id !== "string") {
      throw new Error("The operator API returned an invalid booking response.");
    }
    renderOperatorDetailView(result.booking, true);
  } catch (error) {
    if (requestId === detailRequestId && showingApiDetail) {
      operatorDetail.textContent = "";
      showError(operatorFeedback, error.message || "The operator API could not load this booking.");
    }
  }
}

function renderLocalOperatorDetail(number) {
  const booking = readBookings().find((item) => item.number === number);
  if (!booking) {
    renderLocalOperatorDashboard();
    return;
  }
  renderOperatorDetailView(booking);
}

function renderOperatorDetail(identifier) {
  if (API_MODE) {
    return renderApiOperatorDetail(identifier);
  }
  return renderLocalOperatorDetail(identifier);
}

async function handleApiOperatorAction(action, id) {
  if (action === "cancel" && !window.confirm("Cancel this staging request? This cannot be undone.")) {
    return;
  }

  const actionButton = [...operatorDetail.querySelectorAll("[data-operator-action]")]
    .find((button) => button.dataset.operatorAction === action);
  if (actionButton) actionButton.disabled = true;

  try {
    const result = await apiRequest(`/api/operator/bookings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      credentials: "include",
      body: { action },
    });
    if (!result?.booking) {
      throw new Error("The operator API returned an invalid update response.");
    }
    await renderApiOperatorDashboard();
    await renderApiOperatorDetail(id);
  } catch (error) {
    showError(operatorFeedback, error.message || "The operator API could not save this update.");
    if (actionButton) actionButton.disabled = false;
  }
}

function handleLocalOperatorAction(action, number) {
  const cancelButton = [...operatorDetail.querySelectorAll('[data-operator-action="cancel"]')]
    .find((button) => button.dataset.bookingNumber === number);
  const confirmation = cancelButton?.dataset.cancelConfirmation || "Cancel this request? This cannot be undone in the demo.";
  if (action === "cancel" && !window.confirm(confirmation)) {
    return;
  }

  try {
    const booking = updateBooking(number, (current) => {
      if (action === "advance") {
        const index = STATUS_STEPS.indexOf(current.status);
        const status = index >= 0 ? STATUS_STEPS[index + 1] : null;
        if (!status) return current;
        const at = new Date().toISOString();
        return { ...current, status, statusHistory: [...getStatusHistory(current, STATUS_STEPS), { status, at }] };
      }
      if (action === "cancel") {
        const index = STATUS_STEPS.indexOf(current.status);
        if (index < 0 || index >= STATUS_STEPS.indexOf("Laundry picked up")) return current;
        const at = new Date().toISOString();
        return { ...current, status: STATUS_CANCELLED, statusHistory: [...getStatusHistory(current, STATUS_STEPS), { status: STATUS_CANCELLED, at }] };
      }
      if (action === "paid" && current.paymentStatus !== "paid" && current.status !== STATUS_CANCELLED) {
        return { ...current, paymentStatus: "paid", paidAt: new Date().toISOString() };
      }
      return current;
    });
    if (!booking) {
      showError(operatorFeedback, "This booking is no longer available in this browser.");
      renderLocalOperatorDashboard();
      return;
    }
    renderLocalOperatorDetail(number);
  } catch {
    showError(operatorFeedback, "The update could not be saved in this browser. Try again or stop using the demo.");
  }
}

function handleOperatorAction(action, identifier) {
  if (API_MODE) {
    return handleApiOperatorAction(action, identifier);
  }
  return handleLocalOperatorAction(action, identifier);
}

export function initializeOperator() {
  operatorFilter.addEventListener("change", renderOperatorDashboard);
  document.querySelector("#operator-refresh").addEventListener("click", renderOperatorDashboard);
  if (!API_MODE) {
    window.addEventListener("storage", (event) => {
      if (event.key === "lazyLaundryBookings" && !document.querySelector("#operator-view").classList.contains("hidden")) {
        renderOperatorDashboard();
      }
    });
  }
}
