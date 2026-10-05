import { PAYMENT_LABELS, SERVICE_LABELS, STATUS_ACTIONS, STATUS_CANCELLED, STATUS_STEPS } from "../../shared/constants.js";
import { escapeHtml, formatAdminTimestamp, formatDate, formatMoney, formatSlot, getMaxBookingDateString, getSlotsForDate, getStatusHistory, getTodayString, isSlotClosed } from "../../shared/utils.js";
import { badgeVariants, buttonVariants, surfaceVariants } from "../../shared/variants.js";

const html = escapeHtml;
const money = (value) => html(formatMoney(Number(value) || 0));

function pickupDate(value) {
  try { return value ? formatDate(value) : "Date not recorded"; } catch { return "Date not recorded"; }
}

function pickupSlot(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? `${value} MYT` : "Slot not recorded";
}

function queueDate(value) {
  try { return value ? new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00+08:00`)) : "No date"; } catch { return "No date"; }
}

export function statusTone(status) {
  if (status === "Delivered") return "success";
  if (status === STATUS_CANCELLED) return "danger";
  if (status === "Confirmed") return "warning";
  return "info";
}

function badge(label, tone = "neutral") {
  return `<span class="${html(badgeVariants({ tone }))}">${html(label)}</span>`;
}

function button(label, attributes, intent = "secondary", size = "sm") {
  return `<button type="button" class="${html(buttonVariants({ intent, size }))}" ${attributes}>${html(label)}</button>`;
}

export function filterBookings(bookings, status = "all", query = "") {
  const search = query.trim().toLocaleLowerCase();
  return bookings.filter((booking) => {
    if (status === "pending" && booking.status !== "Confirmed") return false;
    if (status === "active" && ["Confirmed", "Delivered", STATUS_CANCELLED].includes(booking.status)) return false;
    if (status === "completed" && booking.status !== "Delivered") return false;
    if (status === "cancelled" && booking.status !== STATUS_CANCELLED) return false;
    const searchable = [booking.number, booking.name, booking.phone, booking.block, booking.unit, booking.address, booking.status, booking.pickupDate, SERVICE_LABELS[booking.service]].filter(Boolean).join(" ").toLocaleLowerCase();
    return !search || searchable.includes(search);
  }).sort((left, right) => `${left.pickupDate || ""}T${left.pickupSlot || ""}`.localeCompare(`${right.pickupDate || ""}T${right.pickupSlot || ""}`));
}

export function summarizeBookings(bookings) {
  return bookings.reduce((summary, booking) => {
    if (booking.status === "Confirmed") summary.pending += 1;
    else if (!["Delivered", STATUS_CANCELLED].includes(booking.status)) summary.active += 1;
    if (booking.status !== STATUS_CANCELLED) {
      if (booking.paymentStatus === "unpaid") summary.unpaid += 1;
      if (booking.paymentStatus === "paid") summary.collected += Math.round((Number(booking.total) || 0) * 100);
    }
    return summary;
  }, { pending: 0, active: 0, unpaid: 0, collected: 0 });
}

export function renderQueue(bookings, selectedId) {
  return bookings.map((booking) => {
    const next = getEligibility(booking).nextStatus;
    const location = [booking.block, booking.unit ? `Unit ${booking.unit}` : ""].filter(Boolean).join(" · ") || booking.address || "Location not recorded";
    return `<li class="operator-order-card${booking.id === selectedId ? " is-open" : ""}">
      <div class="operator-card-top"><strong class="operator-card-number">${html(booking.number || "No booking number")}</strong>${badge(booking.status || "Not recorded", statusTone(booking.status))}</div>
      <p class="operator-card-name">${html(booking.name || "Unnamed booking")}</p>
      <p class="operator-card-location">${html(location)}</p>
      <p class="operator-card-pickup"><span>${html(queueDate(booking.pickupDate))}</span><span aria-hidden="true">·</span><span>${html(pickupSlot(booking.pickupSlot))}</span></p>
      <p class="operator-card-service">${html(`${booking.packageSize || "?"} pieces · ${SERVICE_LABELS[booking.service] || "Service not recorded"}`)}</p>
      ${next ? `<p class="operator-card-next">Next: ${html(STATUS_ACTIONS[next])}</p>` : ""}
      <div class="operator-card-bottom">
        <div class="operator-card-total"><strong>${money(booking.total)}</strong><span>${booking.paymentStatus === "paid" ? "Collected" : booking.status === STATUS_CANCELLED ? "Cancelled" : "Payment due"}</span></div>
        <div class="operator-card-actions">
          ${button("Open order", `data-booking-id="${html(booking.id)}" aria-label="Open order ${html(booking.number || "booking")}"`, "primary")}
          ${button("Edit booking", `data-booking-edit="${html(booking.id)}" aria-label="Edit booking ${html(booking.number || "booking")}"`, "secondary")}
        </div>
      </div>
    </li>`;
  }).join("");
}

export function getEligibility(booking) {
  const index = STATUS_STEPS.indexOf(booking.status);
  const nextStatus = index >= 0 ? STATUS_STEPS[index + 1] : null;
  const preCollection = ["Confirmed", "Pickup on the way"].includes(booking.status);
  const pickupAt = Date.parse(`${booking.pickupDate}T${booking.pickupSlot}:00+08:00`);
  return {
    nextStatus,
    advance: Boolean(nextStatus) && (nextStatus !== "Delivered" || booking.paymentStatus === "paid"),
    cancel: preCollection && booking.paymentStatus === "unpaid",
    no_show: preCollection && booking.paymentStatus === "unpaid" && Number.isFinite(pickupAt) && Date.now() >= pickupAt + 45 * 60 * 1000,
    reopen: booking.status === STATUS_CANCELLED && booking.paymentStatus === "unpaid",
    paid: booking.paymentStatus === "unpaid" && booking.status !== STATUS_CANCELLED,
    edit: preCollection && booking.paymentStatus === "unpaid",
  };
}

function field(label, value) {
  return `<div><dt>${html(label)}</dt><dd>${html(value || "Not recorded")}</dd></div>`;
}

const EDIT_BLOCKS = ["Block A/B", "Block C", "Block E", "Colonial"];

function editSection(booking, eligibility) {
  if (!eligibility.edit) {
    const why = booking.paymentStatus === "paid"
      ? "Paid orders can no longer be edited — record a payment correction under Activity instead."
      : "This order is past collection or cancelled — contact and schedule changes need an audited exceptional action under Activity.";
    return `<section class="operator-detail-section"><h3 class="operator-section-title">Edit booking</h3><p class="operator-help">${why}</p></section>`;
  }
  const date = typeof booking.pickupDate === "string" && booking.pickupDate ? booking.pickupDate : getTodayString();
  const dateMin = date < getTodayString() ? date : getTodayString();
  const slot = booking.pickupSlot;
  const slots = getSlotsForDate(date);
  if (slot && !slots.includes(slot)) slots.push(slot);
  const slotOptions = slots.map((value) => `<option value="${value}"${value === slot ? " selected" : ""}${isSlotClosed(date, value) && value !== slot ? " disabled" : ""}>${html(formatSlot(value))}</option>`).join("");
  return `
    <section class="operator-detail-section operator-edit-section" id="operator-edit-section" aria-labelledby="operator-edit-title">
      <h3 class="operator-section-title" id="operator-edit-title">Edit booking</h3>
      <p class="operator-help">Edits are audited and need a reason. Package or service changes reprice the order total; pickup changes reserve the new slot.</p>
      <div class="operator-edit-grid">
        <div class="operator-edit-field"><label for="operator-edit-name">Customer name</label><input class="text-input" id="operator-edit-name" maxlength="120" autocomplete="off" value="${html(booking.name || "")}"></div>
        <div class="operator-edit-field"><label for="operator-edit-phone">Phone</label><input class="text-input" id="operator-edit-phone" inputmode="tel" maxlength="16" autocomplete="off" value="${html(booking.phone || "")}"></div>
        <div class="operator-edit-field"><label for="operator-edit-block">Block</label><select class="text-input" id="operator-edit-block">${EDIT_BLOCKS.map((block) => `<option${block === booking.block ? " selected" : ""}>${block}</option>`).join("")}</select></div>
        <div class="operator-edit-field"><label for="operator-edit-unit">Unit</label><input class="text-input" id="operator-edit-unit" maxlength="12" autocomplete="off" placeholder="A-8-02" value="${html(booking.unit || "")}"></div>
        <div class="operator-edit-field"><label for="operator-edit-package">Package</label><select class="text-input" id="operator-edit-package">${[10, 18].map((size) => `<option value="${size}"${size === booking.packageSize ? " selected" : ""}>${size} pieces</option>`).join("")}</select></div>
        <div class="operator-edit-field"><label for="operator-edit-service">Service</label><select class="text-input" id="operator-edit-service">${Object.entries(SERVICE_LABELS).map(([value, label]) => `<option value="${value}"${value === booking.service ? " selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="operator-edit-field"><label for="operator-edit-payment">Payment method</label><select class="text-input" id="operator-edit-payment">${Object.entries(PAYMENT_LABELS).map(([value, label]) => `<option value="${value}"${value === booking.paymentMethod ? " selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="operator-edit-field"><label for="operator-edit-date">Pickup date</label><input class="text-input" type="date" id="operator-edit-date" min="${dateMin}" max="${getMaxBookingDateString()}" value="${html(date)}"></div>
        <div class="operator-edit-field"><label for="operator-edit-slot">Pickup slot · MYT</label><select class="text-input" id="operator-edit-slot">${slotOptions}</select></div>
        <div class="operator-edit-field operator-edit-checks" role="group" aria-labelledby="operator-edit-finish-label"><span id="operator-edit-finish-label">Finish options</span>
          <label class="operator-dialog-check"><input type="checkbox" id="operator-edit-folding"${booking.folding !== false ? " checked" : ""}> Folded</label>
          <label class="operator-dialog-check"><input type="checkbox" id="operator-edit-ironing"${booking.ironing !== false ? " checked" : ""}> Ironed</label>
          <label class="operator-dialog-check"><input type="checkbox" id="operator-edit-hangers"${booking.hangers === true ? " checked" : ""}> On hangers</label>
        </div>
      </div>
      <div class="operator-edit-field"><label for="operator-edit-reason">Audit reason <span class="operator-dialog-required">Required</span></label><textarea class="text-input" id="operator-edit-reason" rows="2" maxlength="500" autocomplete="off" placeholder="Why is this booking being changed?"></textarea></div>
      <p class="form-error" id="operator-edit-error" role="alert" hidden></p>
      <div class="operator-actions">${button("Save changes", 'id="operator-edit-save" data-operator-action="edit" type="button"', "primary")}</div>
    </section>`;
}

function historyMarkup(booking) {
  const events = Array.isArray(booking.events) && booking.events.length ? booking.events : getStatusHistory(booking, STATUS_STEPS).map((entry) => ({ type: "status", to: entry.status, at: entry.at }));
  return `<ol class="operator-history">${events.map((event) => `<li><span class="operator-history-dot" aria-hidden="true"></span><div><strong>${html(event.type === "payment" ? "Payment recorded" : event.type === "edit" ? `Edited: ${event.to || "fields"}` : event.to || event.type || "Update")}</strong><small>${html(formatAdminTimestamp(event.at))}${event.actor ? ` · ${html(event.actor)}` : ""}</small></div></li>`).join("")}</ol>`;
}

export function renderDetail(booking) {
  const eligibility = getEligibility(booking);
  const penalties = Array.isArray(booking.penalties) ? booking.penalties : [];
  const notes = Array.isArray(booking.notes) ? booking.notes : [];
  const paid = booking.paymentStatus === "paid";
  return `
    <div class="operator-detail-status" id="operator-detail-status" role="status" hidden></div>
    <div class="operator-tabpanel" role="tabpanel" id="operator-panel-overview" aria-labelledby="operator-tab-overview" tabindex="0">
      <div class="operator-detail-heading"><div class="operator-detail-title-group"><span class="operator-order-number">${html(booking.number || "Booking")}</span><h2 id="operator-detail-title" tabindex="-1">${html(booking.name || "Unnamed booking")}</h2></div>${badge(booking.status || "Not recorded", statusTone(booking.status))}</div>
      <section class="operator-detail-section" aria-labelledby="operator-order-info-title"><h3 class="operator-section-title" id="operator-order-info-title">Pickup & service</h3><dl class="operator-detail-grid">
        ${field("Phone", booking.phone)}${field("Pickup location", booking.address || [booking.block, booking.unit].filter(Boolean).join(", "))}${field("Pickup · MYT", `${pickupDate(booking.pickupDate)}, ${pickupSlot(booking.pickupSlot)}`)}${field("Package / service", `${booking.packageSize || "?"} pieces · ${SERVICE_LABELS[booking.service] || "Service not recorded"}`)}
      </dl></section>
      <section class="operator-detail-section operator-payment-primary" aria-labelledby="operator-payment-title"><div class="operator-section-heading"><h3 id="operator-payment-title">Payment</h3>${badge(paid ? "Collected" : "Unpaid", paid ? "success" : "warning")}<strong class="operator-payment-amount">${money(booking.total)}</strong></div><div class="operator-payment-method"><span>${html(PAYMENT_LABELS[booking.paymentMethod] || "Method not recorded")}</span>${eligibility.paid ? button("Mark payment collected", 'data-operator-action="paid"', "secondary") : ""}</div></section>
      <section class="operator-detail-section operator-next-action ${html(surfaceVariants({ tone: "tinted", padding: "sm" }))}" aria-labelledby="operator-next-title">
        <div class="operator-section-heading"><h3 id="operator-next-title">Next step</h3></div>
        <div class="operator-actions">${eligibility.nextStatus ? button(STATUS_ACTIONS[eligibility.nextStatus], `data-operator-action="advance"${eligibility.advance ? "" : " disabled"}`, "primary") : `<p>${booking.status === STATUS_CANCELLED ? "Cancelled · see exceptional actions to reopen." : "Order complete."}</p>`}</div>
        ${eligibility.nextStatus === "Delivered" && !paid ? '<p class="operator-help">Collect payment before marking delivered.</p>' : ""}
      </section>
    </div>
    <div class="operator-tabpanel" role="tabpanel" id="operator-panel-booking" aria-labelledby="operator-tab-booking" tabindex="0" hidden>
      <section class="operator-detail-section"><h3 class="operator-section-title">Booking details</h3><dl class="operator-detail-grid">
        ${eligibility.edit ? "" : `${field("Customer name", booking.name)}${field("Phone", booking.phone)}${field("Pickup location", booking.address || [booking.block, booking.unit].filter(Boolean).join(", "))}${field("Pickup · MYT", `${pickupDate(booking.pickupDate)}, ${pickupSlot(booking.pickupSlot)}`)}${field("Package / service", `${booking.packageSize || "?"} pieces · ${SERVICE_LABELS[booking.service] || "Service not recorded"}`)}${field("Payment method", PAYMENT_LABELS[booking.paymentMethod])}${field("Finish", [booking.folding ? "Folded" : "", booking.ironing ? "Ironed" : "", booking.hangers ? "Hangers included" : ""].filter(Boolean).join(" · "))}`}
        ${field("Expected ready · MYT", booking.readyTime)}${field("Booking number", booking.number)}
      </dl>
      <div class="operator-detail-footer">Revision ${html(booking.revision ?? "not recorded")} · Updated ${html(formatAdminTimestamp(booking.updatedAt))}</div></section>
      ${editSection(booking, eligibility)}
    </div>
    <div class="operator-tabpanel" role="tabpanel" id="operator-panel-activity" aria-labelledby="operator-tab-activity" tabindex="0" hidden>
    <details class="operator-disclosure" data-section="notes"><summary id="operator-notes-title">Private notes <span id="operator-note-draft-state"></span></summary><div class="operator-disclosure-body"><label class="operator-note-label" for="operator-note-input">Add an operational note</label><textarea class="text-input operator-note-input" id="operator-note-input" rows="3" maxlength="2000" autocomplete="off" placeholder="What should the next operator know?"></textarea><div class="operator-note-footer"><span>Plain text · 2,000 characters. No tracking credentials.</span>${button("Save note", "data-operator-note")}</div><details class="operator-disclosure operator-nested-disclosure" data-section="note-history"><summary>Note history (${notes.length})</summary><ol class="operator-note-history">${notes.map((note) => `<li><p>${html(note.note)}</p><small>${html(note.actor || "Operator")} · ${html(formatAdminTimestamp(note.at))}</small></li>`).join("")}</ol>${notes.length ? "" : '<p class="operator-help">No private notes recorded.</p>'}</details></div></details>
    <details class="operator-disclosure" data-section="tracking"><summary id="operator-tracking-title">Private tracking administration</summary><div class="operator-disclosure-body"><p class="operator-help operator-private-link-warning">Bearer credential: share only through a verified private channel. Links stay in memory and clear on order switch, close or smaller screens.</p><div class="operator-actions">${button("Share link", 'data-operator-tracking-action="share"')}${button("Rotate link", 'data-operator-tracking-action="rotate"')}${button("Revoke link", 'data-operator-tracking-action="revoke"', "danger")}</div><div class="operator-tracking-output" id="operator-tracking-output" hidden><label for="operator-tracking-link">Current generated link</label><div><input class="text-input" id="operator-tracking-link" type="text" readonly autocomplete="off" spellcheck="false" />${button("Copy", 'id="operator-tracking-copy"', "secondary")}</div></div><p class="operator-help" id="operator-tracking-feedback" role="status" aria-live="polite"></p></div></details>
    <details class="operator-disclosure" data-section="fees"><summary id="operator-fees-title">Fees & total breakdown</summary><div class="operator-disclosure-body"><dl class="operator-payment-breakdown"><div><dt>Service</dt><dd>${money(booking.serviceTotal ?? booking.total)}</dd></div><div><dt>Allocated fees</dt><dd>${money(booking.feeTotal)}</dd></div><div class="operator-payment-total"><dt>Order total</dt><dd>${money(booking.total)}</dd></div></dl><p class="operator-help">Customer account · ${penalties.length} loaded incidents</p>${penalties.length ? `<ul class="operator-fee-list">${penalties.map((penalty) => `<li><div><strong>${money(penalty.amount)} · ${html(penalty.reason || "Incident")}</strong><small>${html(penalty.state)} · ${html(formatAdminTimestamp(penalty.createdAt))}</small>${penalty.note ? `<p>${html(penalty.note)}</p>` : ""}${penalty.allocatedBookingId && penalty.allocatedBookingId !== booking.id ? '<small>Allocated to another booking on this account</small>' : ""}</div>${["outstanding", "allocated"].includes(penalty.state) && !(penalty.allocatedBookingId === booking.id && paid) ? button("Waive", `data-operator-waive="${html(penalty.id)}"`) : ""}</li>`).join("")}</ul>` : '<p class="operator-help">No fee incidents recorded.</p>'}</div></details>
    <details class="operator-disclosure" data-section="history"><summary id="operator-history-title">Order audit history</summary><div class="operator-disclosure-body">${historyMarkup(booking)}</div></details>
    <details class="operator-disclosure" data-section="exceptions"><summary>Exceptional actions</summary><div class="operator-disclosure-body"><div class="operator-actions">${eligibility.cancel ? `${button("Cancel booking", 'data-operator-action="cancel"', "danger")}${button("Record no-show", `data-operator-action="no_show"${eligibility.no_show ? "" : ' disabled aria-describedby="operator-no-show-help"'}`, "danger")}` : ""}${eligibility.reopen ? button("Reopen booking", 'data-operator-action="reopen"', "secondary") : ""}</div>${eligibility.cancel && !eligibility.no_show ? '<p class="operator-help" id="operator-no-show-help">No-show is available 45 minutes after the pickup slot starts.</p>' : ""}<p class="operator-help">A specific audit reason and confirmation are required.${!eligibility.cancel && !eligibility.reopen ? " No exceptional actions are available for this order." : ""}</p>${booking.cancellationReason ? `<p class="operator-help">Cancellation: ${html(booking.cancellationReason)}</p>` : ""}</div></details>
    </div>
  `;
}

export function renderDetailPlaceholder(message = "Select an order") {
  return `<div class="operator-detail-placeholder"><h2>${html(message)}</h2><p>Pickup, payment and the next action appear here.</p></div>`;
}

export function renderDetailFailure(message) {
  return `<div class="operator-detail-placeholder"><h2 id="operator-detail-title" tabindex="-1">Order could not be loaded</h2><p role="alert">${html(message || "Check the connection and retry.")}</p><div class="operator-actions">${button("Retry", 'id="operator-detail-retry"', "primary")}</div></div>`;
}
