import { apiRequest } from "../../shared/api.js";
import { PAYMENT_LABELS, PRICING, SERVICE_LABELS } from "../../shared/constants.js";
import { clearError, escapeHtml, formatDate, formatMoney, formatSlot, getSlotsForDate, isSlotClosed, showError } from "../../shared/utils.js";
import { applyVariants } from "../../shared/variants.js";
import { getEligibility, renderDetail, renderDetailFailure, renderDetailPlaceholder, renderQueue, summarizeBookings } from "./components.js";
import { cancelOperatorDialog, requestActionDialog, requestDiscardDialog, requestOperatorDialog } from "./dialogs.js";
import { assertBooking, exportOperatorBookings, saveOperatorAction } from "./actions.js";

const PAGE_SIZE = 10;
const DRAWER_TABS = ["overview", "booking", "activity"];

let elements = null;
let initialized = false;
let enabled = false;
let bookings = [];
let selectedId = null;
let selectedBooking = null;
let renderedId = null;
let trackingLink = "";
let trackingMessage = "";
let busy = false;
let activeAction = null;
let transitionPending = false;
let lockMessage = "";
let listLoading = false;
let detailLoading = false;
let searchPending = false;
let listFailed = false;
let hasPage = false;
let summaryScope = "Overall";
let filters = { status: "all", query: "", date: "", offset: 0 };
let page = { offset: 0, limit: PAGE_SIZE, total: 0, hasMore: false };
let detailState = { id: null, note: "", sections: new Set(), scroll: 0, tab: "overview", edit: null };
let lastQueueFocus = null;
let suspendedDraft = null;
let listRequestId = 0;
let detailRequestId = 0;
let workspaceVersion = 0;
let listController = null;
let detailController = null;
let exportController = null;
let searchTimer = null;

function desktopAvailable() {
  return enabled && window.matchMedia("(min-width: 1024px)").matches;
}

function clearTracking() {
  trackingLink = "";
  trackingMessage = "";
  const input = elements?.detail.querySelector("#operator-tracking-link");
  if (input) input.value = "";
  const output = elements?.detail.querySelector("#operator-tracking-output");
  if (output) output.hidden = true;
  const feedback = elements?.detail.querySelector("#operator-tracking-feedback");
  if (feedback) feedback.textContent = "";
}

function showSuccess(message) {
  elements.success.textContent = message;
  elements.success.hidden = false;
}

function clearFeedback() {
  clearError(elements.feedback);
  elements.success.hidden = true;
  elements.success.textContent = "";
}

const EDIT_FIELD_IDS = { name: "operator-edit-name", phone: "operator-edit-phone", block: "operator-edit-block", unit: "operator-edit-unit", packageSize: "operator-edit-package", service: "operator-edit-service", paymentMethod: "operator-edit-payment", pickupDate: "operator-edit-date", pickupSlot: "operator-edit-slot", reason: "operator-edit-reason" };
const EDIT_CHECK_IDS = { folding: "operator-edit-folding", ironing: "operator-edit-ironing", hangers: "operator-edit-hangers" };

function captureEditValues() {
  if (!elements?.detail.querySelector(`#${EDIT_FIELD_IDS.name}`)) return null;
  const values = {};
  for (const [key, id] of Object.entries(EDIT_FIELD_IDS)) values[key] = elements.detail.querySelector(`#${id}`)?.value ?? "";
  for (const [key, id] of Object.entries(EDIT_CHECK_IDS)) values[key] = elements.detail.querySelector(`#${id}`)?.checked === true;
  return values;
}

function editBaselineValues() {
  const booking = selectedBooking;
  if (!booking) return null;
  return {
    name: booking.name || "", phone: booking.phone || "", block: booking.block || "", unit: booking.unit || "",
    packageSize: String(booking.packageSize ?? ""), service: booking.service || "", paymentMethod: booking.paymentMethod || "",
    pickupDate: booking.pickupDate || "", pickupSlot: booking.pickupSlot || "", reason: "",
    folding: booking.folding !== false, ironing: booking.ironing !== false, hangers: booking.hangers === true,
  };
}

function editIsDirty() {
  const baseline = editBaselineValues();
  if (!detailState.edit || !baseline) return false;
  return Object.keys(baseline).some((key) => String(detailState.edit[key] ?? "") !== String(baseline[key] ?? ""));
}

function describeOperatorEdit(booking, values) {
  const fmt = (key, value) => key === "packageSize" ? `${value} pieces`
    : key === "service" ? SERVICE_LABELS[value] || value
    : key === "paymentMethod" ? PAYMENT_LABELS[value] || value
    : key === "pickupDate" ? formatDate(value)
    : key === "pickupSlot" ? `${formatSlot(value)} MYT`
    : String(value);
  const labels = { name: "Name", phone: "Phone", block: "Block", unit: "Unit", packageSize: "Package", service: "Service", paymentMethod: "Payment", pickupDate: "Pickup date", pickupSlot: "Pickup slot" };
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    const from = key === "name" ? booking.name : booking[key];
    if (values[key] !== undefined && String(values[key]) !== String(from ?? "")) parts.push(`${label}: ${fmt(key, from)} → ${fmt(key, values[key])}`);
  }
  if (["folding", "ironing", "hangers"].some((key) => values[key] !== undefined && values[key] !== (key === "hangers" ? booking.hangers === true : booking[key] !== false))) parts.push("Finish options updated");
  const tier = PRICING[Number(values.packageSize)];
  if (tier && (Number(values.packageSize) !== booking.packageSize || values.service !== booking.service || values.hangers !== (booking.hangers === true))) {
    const serviceTotal = tier.base + (values.service === "express" ? tier.express : 0) + (values.hangers === true ? tier.hanger : 0);
    const newTotal = serviceTotal + Number(booking.feeTotal || 0);
    parts.push(`Total: ${formatMoney(Number(booking.total))} → ${formatMoney(newTotal)}`);
  }
  return parts.join(" · ") || "Details updated";
}

function refreshEditSlotOptions() {
  const dateInput = elements.detail.querySelector(`#${EDIT_FIELD_IDS.pickupDate}`);
  const slotSelect = elements.detail.querySelector(`#${EDIT_FIELD_IDS.pickupSlot}`);
  if (!dateInput || !slotSelect) return;
  const date = dateInput.value;
  const keep = slotSelect.value;
  const currentSlot = date === selectedBooking?.pickupDate ? selectedBooking.pickupSlot : "";
  const slots = getSlotsForDate(date);
  for (const extra of [keep, currentSlot]) if (extra && !slots.includes(extra)) slots.push(extra);
  slotSelect.innerHTML = "";
  for (const slot of slots) {
    const option = document.createElement("option");
    option.value = slot;
    option.textContent = formatSlot(slot);
    option.disabled = isSlotClosed(date, slot) && slot !== currentSlot;
    option.selected = slot === keep;
    slotSelect.append(option);
  }
}

function captureDetailState() {
  if (!elements || !selectedId || renderedId !== selectedId || detailState.id !== selectedId) return;
  const input = elements.detail.querySelector("#operator-note-input");
  if (input) detailState.note = input.value;
  detailState.edit = captureEditValues();
  detailState.sections = new Set([...elements.detail.querySelectorAll("details[data-section][open]")].map((section) => section.dataset.section));
  detailState.scroll = elements.detail.scrollTop;
}

function hasDraft() {
  captureDetailState();
  return Boolean(detailState.note.length || editIsDirty() || suspendedDraft?.note.length || suspendedDraft?.edit);
}

function updateDraftLabel() {
  const label = elements.detail.querySelector("#operator-note-draft-state");
  if (label) label.textContent = detailState.note.length ? "· Unsaved draft" : "";
}

function focusSnapshot() {
  const active = document.activeElement;
  if (!elements.detail.contains(active)) return null;
  if (active.id) return { selector: `#${CSS.escape(active.id)}`, start: active.selectionStart, end: active.selectionEnd };
  for (const attribute of ["data-operator-action", "data-operator-tracking-action", "data-operator-waive", "data-operator-note"]) {
    if (active.hasAttribute(attribute)) return { selector: `[${attribute}="${CSS.escape(active.getAttribute(attribute))}"]` };
  }
  if (active.matches("summary")) return { selector: `details[data-section="${CSS.escape(active.parentElement.dataset.section)}"] > summary` };
  return null;
}

function restoreDetailFocus(snapshot) {
  const target = snapshot && elements.detail.querySelector(snapshot.selector);
  if (!target || target.disabled || target.closest("details:not([open])") && !target.matches("summary")) return false;
  target.focus({ preventScroll: true });
  if (typeof snapshot.start === "number" && target.setSelectionRange) target.setSelectionRange(snapshot.start, snapshot.end);
  return true;
}

function updateSummary(result, nextBookings) {
  const server = result.summary;
  if (server && !["pending", "active", "unpaid", "collected"].every((key) => Number.isFinite(server[key]) && server[key] >= 0)) throw new Error("The operator API returned an invalid summary.");
  const fallback = server ? null : summarizeBookings(nextBookings);
  const summary = server || { ...fallback, collected: fallback.collected / 100 };
  summaryScope = server ? "Overall" : "Page only";
  elements.summary.setAttribute("aria-label", `${summaryScope} order summary`);
  elements.pending.textContent = String(summary.pending);
  elements.active.textContent = String(summary.active);
  elements.unpaid.textContent = String(summary.unpaid);
  elements.collected.textContent = formatMoney(summary.collected);
  elements.summaryHelp.textContent = server ? "Overall summary covers all database orders, regardless of queue filters. Confirmed awaits pickup; active is in progress. Payment due and collected exclude cancelled orders." : "This legacy response has no database summary. These totals cover only the displayed page, not all orders. Payment due and collected exclude cancelled orders.";
}

function updateScope() {
  elements.scope.textContent = `${summaryScope} summary · Database queue · CSV: status/date only, up to 100.`;
}

function rangeLabel() {
  if (!hasPage) return "No results loaded";
  return page.total ? `${bookings.length ? page.offset + 1 : 0}–${page.offset + bookings.length} of ${page.total}` : "0 of 0";
}

function updateQueue() {
  const focusedControl = document.activeElement?.closest("[data-booking-id], [data-booking-edit]");
  const focusedId = focusedControl?.dataset.bookingId || focusedControl?.dataset.bookingEdit;
  const focusedKey = focusedControl?.dataset.bookingEdit ? "data-booking-edit" : "data-booking-id";
  const scroll = elements.list.scrollTop;
  elements.list.innerHTML = renderQueue(bookings, selectedId);
  elements.list.scrollTop = scroll;
  elements.empty.hidden = bookings.length > 0 || !hasPage || listLoading || searchPending;
  elements.emptyDescription.textContent = "Try another status, pickup date or search. Refresh to check for new orders.";
  elements.results.textContent = listLoading || searchPending ? "Updating…" : `${rangeLabel()}${listFailed ? " · refresh failed" : ""}`;
  elements.pageInfo.textContent = listLoading || searchPending ? "Updating…" : rangeLabel();
  updateScope();
  updateBusyControls();
  if (focusedId) [...elements.list.querySelectorAll(`[${focusedKey}]`)].find((button) => (button.dataset.bookingId || button.dataset.bookingEdit) === focusedId && !button.disabled)?.focus({ preventScroll: true });
}

function updateDetailStatus() {
  const status = elements.detail.querySelector("#operator-detail-status");
  if (!status) return;
  status.hidden = !lockMessage && !detailLoading;
  status.setAttribute("role", lockMessage ? "alert" : "status");
  status.innerHTML = lockMessage ? `<p>${escapeHtml(lockMessage)}</p><div class="operator-actions"><button type="button" id="operator-detail-retry" data-ui="button" data-intent="secondary" data-size="sm">Refresh order</button><button type="button" id="operator-detail-close" data-ui="button" data-intent="ghost" data-size="sm">Close detail</button></div>` : "Refreshing order…";
  applyVariants(status);
}

function updateBusyControls() {
  if (!elements) return;
  elements.refresh.disabled = busy || transitionPending || listLoading || detailLoading || searchPending;
  elements.refresh.textContent = listLoading || detailLoading ? "Refreshing…" : "Refresh";
  [elements.search, elements.filter, elements.date].forEach((input) => { input.disabled = busy || transitionPending; });
  const queueBlocked = busy || transitionPending || listLoading || searchPending;
  elements.prev.disabled = queueBlocked || !hasPage || page.offset === 0;
  elements.next.disabled = queueBlocked || !hasPage || !page.hasMore;
  elements.export.disabled = busy || transitionPending || Boolean(exportController);
  elements.export.textContent = exportController ? "Exporting…" : "Export CSV";
  elements.list.querySelectorAll("[data-booking-id], [data-booking-edit]").forEach((button) => { button.disabled = queueBlocked; });
  elements.backList.disabled = busy || transitionPending || searchPending;
  elements.drawerRefresh.disabled = busy || transitionPending || listLoading || detailLoading || searchPending;
  elements.drawerRefresh.textContent = listLoading || detailLoading ? "Refreshing…" : "Refresh";
  elements.detail.setAttribute("aria-busy", String(busy || detailLoading));
  const eligibility = selectedBooking ? getEligibility(selectedBooking) : {};
  elements.detail.querySelectorAll("[data-operator-action], [data-operator-tracking-action], [data-operator-waive], [data-operator-note]").forEach((button) => {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    const eligible = !button.dataset.operatorAction || eligibility[button.dataset.operatorAction];
    button.disabled = busy || transitionPending || detailLoading || searchPending || Boolean(lockMessage) || !eligible;
    const active = activeAction && (activeAction.kind === "order" && button.dataset.operatorAction === activeAction.action || activeAction.kind === "tracking" && button.dataset.operatorTrackingAction === activeAction.action || activeAction.kind === "note" && button.hasAttribute("data-operator-note") || activeAction.kind === "waive" && button.dataset.operatorWaive === activeAction.penaltyId);
    button.textContent = active ? activeAction.confirming ? "Confirming…" : activeAction.kind === "tracking" ? "Updating link…" : activeAction.kind === "note" ? "Saving note…" : "Saving…" : button.dataset.idleLabel;
  });
  const note = elements.detail.querySelector("#operator-note-input");
  if (note) note.disabled = busy || transitionPending;
  elements.detail.querySelectorAll("#operator-edit-section input, #operator-edit-section select, #operator-edit-section textarea").forEach((input) => {
    input.disabled = busy || transitionPending || detailLoading || searchPending || Boolean(lockMessage) || renderedId !== selectedId;
  });
  elements.detail.querySelectorAll("#operator-detail-close").forEach((button) => { button.disabled = busy || transitionPending || searchPending; });
  const retry = elements.detail.querySelector("#operator-detail-retry");
  if (retry) { retry.disabled = busy || transitionPending || detailLoading || searchPending; retry.textContent = detailLoading ? "Refreshing…" : selectedBooking ? "Refresh order" : "Retry"; }
  const copy = elements.detail.querySelector("#operator-tracking-copy");
  if (copy) copy.disabled = busy || transitionPending || detailLoading || Boolean(lockMessage) || !trackingLink;
}

function syncTabs() {
  const hasPanels = Boolean(renderedId && renderedId === selectedId && selectedBooking);
  elements.drawerTabs.hidden = !hasPanels;
  if (!hasPanels) return;
  const active = DRAWER_TABS.includes(detailState.tab) ? detailState.tab : "overview";
  detailState.tab = active;
  elements.drawerTabs.querySelectorAll('[role="tab"]').forEach((tab) => {
    const on = tab.dataset.tab === active;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = elements.detail.querySelector(`#${CSS.escape(tab.getAttribute("aria-controls"))}`);
    if (panel) panel.hidden = !on;
  });
}

function activateTab(name, { focus = false } = {}) {
  if (!DRAWER_TABS.includes(name)) return;
  detailState.tab = name;
  syncTabs();
  if (focus) elements.drawerTabs.querySelector(`[data-tab="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
}

function drawDetail({ focus = false } = {}) {
  if (!selectedBooking || !desktopAvailable()) return;
  const snapshot = focusSnapshot();
  captureDetailState();
  elements.detail.innerHTML = renderDetail(selectedBooking);
  renderedId = selectedId;
  applyVariants(elements.detail);
  elements.detail.querySelectorAll("details[data-section]").forEach((section) => { section.open = detailState.sections.has(section.dataset.section); });
  elements.detail.querySelector("#operator-note-input").value = detailState.note;
  elements.detail.querySelector("#operator-tracking-link").value = trackingLink;
  elements.detail.querySelector("#operator-tracking-output").hidden = !trackingLink;
  elements.detail.querySelector("#operator-tracking-feedback").textContent = trackingMessage;
  if (detailState.edit) {
    for (const [key, id] of Object.entries(EDIT_FIELD_IDS)) {
      if (key === "pickupSlot") continue;
      const field = elements.detail.querySelector(`#${id}`);
      if (field && detailState.edit[key] !== undefined) field.value = detailState.edit[key];
    }
    for (const [key, id] of Object.entries(EDIT_CHECK_IDS)) {
      const field = elements.detail.querySelector(`#${id}`);
      if (field && detailState.edit[key] !== undefined) field.checked = Boolean(detailState.edit[key]);
    }
    refreshEditSlotOptions();
    const slotField = elements.detail.querySelector(`#${EDIT_FIELD_IDS.pickupSlot}`);
    if (slotField && detailState.edit.pickupSlot) slotField.value = detailState.edit.pickupSlot;
  }
  updateDraftLabel();
  updateDetailStatus();
  updateBusyControls();
  syncTabs();
  elements.detail.scrollTop = detailState.scroll;
  if (focus) elements.detail.querySelector("#operator-detail-title").focus({ preventScroll: true });
  else restoreDetailFocus(snapshot);
}

async function confirmDiscard() {
  if (busy || transitionPending || searchPending) return false;
  if (!hasDraft()) return true;
  if (!desktopAvailable()) return false;
  const version = workspaceVersion;
  const id = selectedId;
  const returnFocus = document.activeElement;
  transitionPending = true;
  updateBusyControls();
  try {
    const discard = await requestDiscardDialog(editIsDirty() ? "edit" : "note");
    if (!discard || !desktopAvailable() || version !== workspaceVersion || id !== selectedId) return false;
    detailState.note = "";
    detailState.edit = null;
    suspendedDraft = null;
    const input = elements.detail.querySelector("#operator-note-input");
    if (input) input.value = "";
    updateDraftLabel();
    return true;
  } finally {
    transitionPending = false;
    if (desktopAvailable()) {
      updateBusyControls();
      if (version !== workspaceVersion) renderOperatorDashboard();
      else if (returnFocus?.isConnected && !returnFocus.disabled && !returnFocus.closest("[hidden]")) returnFocus.focus({ preventScroll: true });
    }
  }
}

function closeDetail({ focus = true } = {}) {
  const previous = lastQueueFocus || { id: selectedId, key: "data-booking-id" };
  detailRequestId += 1;
  detailController?.abort();
  cancelOperatorDialog();
  clearTracking();
  selectedId = null;
  selectedBooking = null;
  renderedId = null;
  lockMessage = "";
  detailLoading = false;
  detailState = { id: null, note: "", sections: new Set(), scroll: 0, tab: "overview", edit: null };
  if (elements.drawer.open) elements.drawer.close();
  elements.drawerTabs.hidden = true;
  elements.detail.innerHTML = renderDetailPlaceholder();
  elements.detail.removeAttribute("aria-busy");
  lastQueueFocus = null;
  updateQueue();
  if (focus) {
    const opener = (previous.id && elements.list.querySelector(`[${previous.key}="${CSS.escape(previous.id)}"]:not(:disabled)`))
      || elements.list.querySelector("[data-booking-id]:not(:disabled)");
    (opener || elements.search).focus();
  }
}

function openDrawer(id, tab = "overview", openerKey = "data-booking-id") {
  lastQueueFocus = { id, key: openerKey };
  if (!elements.drawer.open) elements.drawer.showModal();
  loadDetail(id, { focus: true, tab });
}

async function loadDetail(id, { focus = false, preserveTracking = false, tab } = {}) {
  if (!desktopAvailable()) return false;
  const requestId = ++detailRequestId;
  const version = workspaceVersion;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  captureDetailState();
  if (selectedId !== id) {
    selectedBooking = null;
    renderedId = null;
    lockMessage = "";
    if (detailState.id !== id) detailState = { id, note: "", sections: new Set(), scroll: 0, tab: tab || "overview", edit: null };
  }
  if (tab && DRAWER_TABS.includes(tab)) detailState.tab = tab;
  if (!preserveTracking) clearTracking();
  selectedId = id;
  detailLoading = true;
  if (!selectedBooking) elements.detail.innerHTML = '<div class="operator-detail-loading" role="status">Loading order…</div>';
  syncTabs();
  updateDetailStatus();
  updateQueue();
  try {
    const result = await apiRequest(`/api/operator/bookings/${encodeURIComponent(id)}`, { credentials: "include", signal: controller.signal, timeoutMs: 15000 });
    if (requestId !== detailRequestId || selectedId !== id || version !== workspaceVersion || !desktopAvailable() || controller.signal.aborted) return false;
    const booking = assertBooking(result?.booking, id);
    captureDetailState();
    selectedBooking = booking;
    lockMessage = "";
    detailLoading = false;
    drawDetail({ focus });
    return true;
  } catch (error) {
    if (requestId === detailRequestId && version === workspaceVersion && desktopAvailable() && !controller.signal.aborted && error.name !== "AbortError") {
      detailLoading = false;
      lockMessage = lockMessage || "Order refresh failed. Refresh this order before making changes; your note draft is kept.";
      if (selectedBooking) updateDetailStatus();
      else { elements.detail.innerHTML = renderDetailFailure(error.message); renderedId = null; applyVariants(elements.detail); }
      if (focus) elements.detail.querySelector("#operator-detail-title")?.focus({ preventScroll: true });
    }
    return false;
  } finally {
    if (requestId === detailRequestId && version === workspaceVersion && desktopAvailable()) {
      detailLoading = false;
      updateBusyControls();
    }
  }
}

function invalidateQueue() {
  listRequestId += 1;
  listController?.abort();
  listLoading = false;
  elements.list.removeAttribute("aria-busy");
}

async function loadQueue() {
  if (!desktopAvailable()) return false;
  const requestId = ++listRequestId;
  const version = workspaceVersion;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const requested = { ...filters, limit: PAGE_SIZE };
  listLoading = true;
  elements.list.setAttribute("aria-busy", "true");
  updateQueue();
  if (!hasPage) elements.list.innerHTML = '<li class="operator-list-loading" role="status">Loading orders…</li>';
  try {
    const result = await apiRequest("/api/operator/bookings/search", { method: "POST", credentials: "include", body: requested, signal: controller.signal, timeoutMs: 15000, readOnly: true });
    if (requestId !== listRequestId || version !== workspaceVersion || !desktopAvailable() || controller.signal.aborted) return false;
    if (!Array.isArray(result?.bookings) || result.bookings.some((booking) => !booking || typeof booking.id !== "string")) throw new Error("The operator API returned an invalid bookings response.");
    const responsePage = result.page;
    if (responsePage && (!Number.isInteger(responsePage.offset) || responsePage.offset < 0 || !Number.isInteger(responsePage.limit) || responsePage.limit < 1 || !Number.isInteger(responsePage.total) || responsePage.total < 0 || typeof responsePage.hasMore !== "boolean")) throw new Error("The operator API returned invalid pagination.");
    updateSummary(result, result.bookings);
    bookings = result.bookings;
    page = responsePage || { offset: requested.offset, limit: PAGE_SIZE, total: requested.offset + bookings.length, hasMore: false };
    filters.offset = page.offset;
    hasPage = true;
    listFailed = false;
    listLoading = false;
    updateQueue();
    elements.updated.textContent = `Updated ${new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour: "numeric", minute: "2-digit" }).format(new Date())} MYT`;
    return true;
  } catch (error) {
    if (requestId === listRequestId && version === workspaceVersion && desktopAvailable() && !controller.signal.aborted && error.name !== "AbortError") {
      listLoading = false;
      listFailed = true;
      updateQueue();
      if (!hasPage) elements.list.innerHTML = '<li class="operator-list-loading">Orders could not be loaded. Use Refresh to retry.</li>';
      showError(elements.feedback, error.message || "The operator API could not load orders.");
    }
    return false;
  } finally {
    if (requestId === listRequestId && version === workspaceVersion && desktopAvailable()) {
      listLoading = false;
      elements.list.removeAttribute("aria-busy");
      updateBusyControls();
    }
  }
}

function syncFilterInputs() {
  elements.filter.value = filters.status;
  elements.search.value = filters.query;
  elements.date.value = filters.date;
}

async function changeView(next) {
  if (!desktopAvailable() || busy || transitionPending) return;
  const version = workspaceVersion;
  const returnFocus = document.activeElement;
  clearTimeout(searchTimer);
  searchPending = false;
  invalidateQueue();
  if (next.status === filters.status && next.query === filters.query && next.date === filters.date && next.offset === filters.offset) { await loadQueue(); return; }
  if (!await confirmDiscard()) {
    if (desktopAvailable()) { syncFilterInputs(); await loadQueue(); }
    return;
  }
  if (!desktopAvailable()) return;
  closeDetail({ focus: false });
  filters = next;
  syncFilterInputs();
  bookings = [];
  hasPage = false;
  page = { offset: next.offset, limit: PAGE_SIZE, total: 0, hasMore: false };
  if (summaryScope === "Page only") [elements.pending, elements.active, elements.unpaid, elements.collected].forEach((element) => { element.textContent = "—"; });
  elements.list.scrollTop = 0;
  clearFeedback();
  await loadQueue();
  if (desktopAvailable() && version === workspaceVersion && document.activeElement === document.body) {
    const target = returnFocus?.isConnected && !returnFocus.disabled && !returnFocus.closest("[hidden]") ? returnFocus : elements.pageInfo;
    target.focus({ preventScroll: true });
  }
}

function inputFilters() {
  return { status: elements.filter.value, query: elements.search.value.slice(0, 200), date: elements.date.value, offset: 0 };
}

export async function renderOperatorDashboard() {
  if (!elements || !desktopAvailable() || busy || transitionPending || searchPending) return;
  const version = workspaceVersion;
  const returnFocus = document.activeElement;
  clearFeedback();
  clearTracking();
  const restoredDraft = Boolean(suspendedDraft);
  if (suspendedDraft) {
    detailState = { id: suspendedDraft.id, note: suspendedDraft.note, sections: new Set(suspendedDraft.edit ? [] : ["notes"]), scroll: 0, tab: suspendedDraft.edit ? "booking" : "activity", edit: suspendedDraft.edit || null };
    selectedId = suspendedDraft.id;
    suspendedDraft = null;
    elements.mobileDraft.hidden = true;
    if (!elements.drawer.open) elements.drawer.showModal();
    showSuccess("Unsaved note restored from memory. Open Private notes to save it.");
  }
  const id = selectedId;
  await Promise.all([loadQueue(), id ? loadDetail(id, { focus: restoredDraft }) : Promise.resolve()]);
  if (desktopAvailable() && version === workspaceVersion && document.activeElement === document.body && returnFocus?.isConnected && !returnFocus.disabled && !returnFocus.closest("[hidden]")) returnFocus.focus({ preventScroll: true });
}

async function performAction(kind, action, penaltyId = "") {
  if (!desktopAvailable() || busy || transitionPending || lockMessage || detailLoading || searchPending || !selectedBooking) return;
  const booking = selectedBooking;
  const version = workspaceVersion;
  const snapshot = focusSnapshot();
  captureDetailState();
  clearFeedback();
  let fields;
  if (kind === "note") {
    const input = elements.detail.querySelector("#operator-note-input");
    const note = input.value.trim();
    if (!note || note.length > 2000) {
      showError(elements.feedback, "Enter a plain-text note between 1 and 2000 characters.");
      input.focus();
      return;
    }
    fields = { note };
  } else if (action === "edit") {
    const errorEl = elements.detail.querySelector("#operator-edit-error");
    const values = captureEditValues();
    if (!values) return;
    const fail = (message, focusId) => {
      errorEl.textContent = message;
      errorEl.hidden = false;
      elements.detail.querySelector(`#${focusId}`)?.focus();
    };
    errorEl.hidden = true;
    const reason = values.reason.trim();
    if (!values.name.trim()) return fail("Customer name is required.", "operator-edit-name");
    if (!/^\+[1-9]\d{6,14}$/.test(values.phone.trim())) return fail("Phone must be in international format like +60123456789.", "operator-edit-phone");
    if (!/^[A-Z]-\d{1,2}-\d{1,3}$/i.test(values.unit.trim())) return fail("Unit must look like A-8-02.", "operator-edit-unit");
    if (!values.pickupDate || !values.pickupSlot) return fail("Choose a valid pickup date and slot.", "operator-edit-date");
    if (!reason) return fail("Give a short audit reason for this change.", "operator-edit-reason");
    fields = {
      reason,
      fields: {
        name: values.name.trim(), phone: values.phone.trim(), block: values.block, unit: values.unit.trim(),
        packageSize: Number(values.packageSize), service: values.service, paymentMethod: values.paymentMethod,
        folding: values.folding === true, ironing: values.ironing === true, hangers: values.hangers === true,
        pickupDate: values.pickupDate, pickupSlot: values.pickupSlot,
      },
    };
  }
  const penalty = kind === "waive" ? booking.penalties?.find((item) => item.id === penaltyId) : null;
  if (kind === "waive" && (!penalty || !["outstanding", "allocated"].includes(penalty.state))) return;
  busy = true;
  activeAction = { kind, action, penaltyId, confirming: kind !== "note" };
  updateBusyControls();
  let applied = false;
  let succeeded = false;
  try {
    if (kind !== "note" && action !== "edit") fields = await requestActionDialog(action, booking, penalty);
    else if (action === "edit") {
      const confirmed = await requestOperatorDialog({
        title: "Save booking changes?",
        context: `${booking.number} · ${booking.name}`,
        description: describeOperatorEdit(booking, fields.fields),
        submit: "Save changes",
        cancel: "Keep editing",
      });
      if (confirmed === null) return;
    }
    if (fields === null || !desktopAvailable() || selectedId !== booking.id || workspaceVersion !== version) return;
    activeAction.confirming = false;
    clearTracking();
    updateBusyControls();
    const result = await saveOperatorAction(kind, action, booking, fields, penaltyId);
    applied = true;
    if (kind === "note" && suspendedDraft?.id === booking.id && suspendedDraft.note.trim() === fields.note) {
      suspendedDraft = null;
      elements.mobileDraft.hidden = true;
    }
    if (!desktopAvailable() || selectedId !== booking.id || workspaceVersion !== version) return;
    if (kind === "tracking" || kind === "waive") {
      const loaded = await loadDetail(booking.id, { preserveTracking: true });
      if (!loaded || workspaceVersion !== version || selectedId !== booking.id) {
        if (desktopAvailable() && workspaceVersion === version && selectedId === booking.id) showError(elements.feedback, "Change saved, but the current order could not be loaded. Refresh this order before acting again.");
        return;
      }
      if (kind === "tracking") {
        trackingLink = action === "revoke" ? "" : result.trackingLink;
        trackingMessage = action === "revoke" ? "Link revoked. Rotate before sharing again." : action === "rotate" ? "New link generated; the old link no longer works." : "Current link ready. Share only through a verified private channel.";
      }
    } else {
      if (kind === "note") {
        detailState.note = "";
        const input = elements.detail.querySelector("#operator-note-input");
        if (input) input.value = "";
      }
      if (action === "edit") detailState.edit = null;
      selectedBooking = result.booking;
    }
    drawDetail();
    succeeded = true;
    showSuccess(kind === "note" ? "Private note saved." : kind === "waive" ? "Fee waived. Server balances updated." : kind === "tracking" ? trackingMessage : "Order updated. Change recorded in audit history.");
    await loadQueue();
  } catch (error) {
    if (desktopAvailable() && workspaceVersion === version && selectedId === booking.id) {
      const slotConflict = action === "edit" && error.status === 409 && /slot/i.test(error.message || "");
      if ((error.status === 409 || error.outcomeUnknown || applied) && !slotConflict) {
        lockMessage = error.outcomeUnknown ? "The action may have been saved; its outcome is unknown. Changes are locked. Refresh this order and check its history before doing anything again." : error.status === 409 ? "This order changed elsewhere. Changes are locked until you refresh this order. Your note draft is kept." : "The action was saved, but the order refresh failed. Refresh this order before acting again.";
        clearTracking();
        updateDetailStatus();
      }
      const editError = action === "edit" && !lockMessage ? elements.detail.querySelector("#operator-edit-error") : null;
      if (error.name !== "AbortError" || error.outcomeUnknown) {
        if (editError) { editError.textContent = error.message || "The booking changes could not be saved."; editError.hidden = false; }
        else showError(elements.feedback, lockMessage || error.message || "The operator action could not be saved.");
      }
    }
  } finally {
    busy = false;
    activeAction = null;
    if (desktopAvailable()) {
      updateBusyControls();
      if (workspaceVersion !== version) renderOperatorDashboard();
      else if (selectedId === booking.id) {
        if (succeeded && kind === "note") elements.detail.querySelector("#operator-note-input")?.focus({ preventScroll: true });
        else if (succeeded && kind === "tracking" && trackingLink) elements.detail.querySelector("#operator-tracking-link")?.focus({ preventScroll: true });
        else if (document.activeElement === document.body || succeeded) {
          if (!restoreDetailFocus(snapshot)) elements.detail.querySelector("#operator-detail-title")?.focus({ preventScroll: true });
        }
      }
    }
  }
}

async function copyTrackingLink() {
  if (!desktopAvailable() || busy || detailLoading || lockMessage || !trackingLink) return;
  const id = selectedId;
  const link = trackingLink;
  try {
    await navigator.clipboard.writeText(link);
    if (desktopAvailable() && id === selectedId && link === trackingLink) {
      trackingMessage = "Link copied. Share privately with the customer.";
      elements.detail.querySelector("#operator-tracking-feedback").textContent = trackingMessage;
    }
  } catch {
    if (desktopAvailable() && id === selectedId && link === trackingLink) {
      const input = elements.detail.querySelector("#operator-tracking-link");
      input.focus();
      input.select();
      elements.detail.querySelector("#operator-tracking-feedback").textContent = "Clipboard unavailable. Copy the selected link manually.";
    }
  }
}

export function initializeOperator() {
  if (!window.matchMedia("(min-width: 1024px)").matches || !document.querySelector("#operator-view")) return;
  enabled = true;
  if (initialized) return;
  elements = Object.fromEntries(Object.entries({ list: "operator-booking-list", empty: "operator-empty", emptyDescription: "operator-empty-description", detail: "operator-detail", drawer: "operator-drawer", drawerTabs: "operator-drawer-tabs", backList: "operator-back-list", drawerRefresh: "operator-drawer-refresh", feedback: "operator-feedback", success: "operator-success", filter: "operator-filter", search: "operator-search", date: "operator-date", pending: "operator-pending-count", active: "operator-active-count", unpaid: "operator-unpaid-count", collected: "operator-collected-total", summary: "operator-summary", summaryHelp: "operator-summary-help", refresh: "operator-refresh", export: "operator-export", prev: "operator-prev", next: "operator-next", pageInfo: "operator-page-info", results: "operator-results-count", scope: "operator-data-scope", updated: "operator-last-updated", mobileDraft: "operator-mobile-draft-warning", help: "operator-workspace-help" }).map(([key, id]) => [key, document.getElementById(id)]));
  if (Object.values(elements).some((element) => !element)) { enabled = false; elements = null; return; }
  initialized = true;
  elements.filter.addEventListener("change", () => changeView(inputFilters()));
  elements.date.addEventListener("change", () => changeView(inputFilters()));
  elements.search.addEventListener("input", () => {
    if (!desktopAvailable() || busy || transitionPending) return;
    clearTimeout(searchTimer);
    invalidateQueue();
    searchPending = true;
    updateQueue();
    searchTimer = setTimeout(() => changeView(inputFilters()), 250);
  });
  elements.prev.addEventListener("click", () => changeView({ ...filters, offset: Math.max(0, page.offset - PAGE_SIZE) }));
  elements.next.addEventListener("click", () => changeView({ ...filters, offset: page.offset + PAGE_SIZE }));
  elements.refresh.addEventListener("click", renderOperatorDashboard);
  elements.list.addEventListener("click", async (event) => {
    const control = event.target.closest("[data-booking-id], [data-booking-edit]");
    if (!control || control.disabled || !desktopAvailable() || busy || transitionPending || listLoading || searchPending) return;
    const id = control.dataset.bookingEdit || control.dataset.bookingId;
    const tab = control.dataset.bookingEdit ? "booking" : "overview";
    if (id !== selectedId && !await confirmDiscard()) return;
    if (!desktopAvailable() || busy) return;
    clearFeedback();
    openDrawer(id, tab, control.dataset.bookingEdit ? "data-booking-edit" : "data-booking-id");
  });
  elements.drawer.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !desktopAvailable()) return;
    if (button.id === "operator-back-list") {
      if (!busy && !transitionPending && await confirmDiscard() && desktopAvailable()) closeDetail();
    } else if (button.id === "operator-drawer-refresh" && !busy && !transitionPending) {
      clearFeedback();
      renderOperatorDashboard();
    }
  });
  elements.drawer.addEventListener("cancel", async (event) => {
    event.preventDefault();
    if (busy || transitionPending || !desktopAvailable()) return;
    if (await confirmDiscard() && desktopAvailable()) closeDetail();
  });
  elements.drawerTabs.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && !tab.disabled && desktopAvailable() && renderedId === selectedId) activateTab(tab.dataset.tab);
  });
  elements.drawerTabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...elements.drawerTabs.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
      : tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    activateTab(next.dataset.tab, { focus: true });
  });
  elements.detail.addEventListener("input", (event) => {
    if (event.target.id === "operator-note-input" && renderedId === selectedId) {
      detailState.note = event.target.value;
      updateDraftLabel();
    }
    if (event.target.closest("#operator-edit-section")) detailState.edit = captureEditValues();
  });
  elements.detail.addEventListener("change", (event) => {
    if (event.target.id === "operator-edit-date") refreshEditSlotOptions();
    if (event.target.closest("#operator-edit-section")) detailState.edit = captureEditValues();
  });
  elements.detail.addEventListener("toggle", (event) => {
    const section = event.target;
    if (!section.matches("details[data-section]") || detailState.id !== selectedId) return;
    if (section.open) detailState.sections.add(section.dataset.section);
    else detailState.sections.delete(section.dataset.section);
  }, true);
  elements.detail.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !desktopAvailable()) return;
    if (button.id === "operator-detail-close") {
      if (await confirmDiscard() && desktopAvailable()) closeDetail();
    } else if (button.id === "operator-detail-retry" && !busy && selectedId) { clearFeedback(); await Promise.all([loadDetail(selectedId, { focus: true }), loadQueue()]); }
    else if (button.id === "operator-tracking-copy") copyTrackingLink();
    else if (button.dataset.operatorAction) performAction("order", button.dataset.operatorAction);
    else if (button.dataset.operatorTrackingAction) performAction("tracking", button.dataset.operatorTrackingAction);
    else if (button.hasAttribute("data-operator-note")) performAction("note", "note");
    else if (button.dataset.operatorWaive) performAction("waive", "waive", button.dataset.operatorWaive);
  });
  document.addEventListener("keydown", async (event) => {
    if (event.key !== "Escape" || !desktopAvailable() || elements.drawer.open || document.querySelector(".operator-dialog[open]")) return;
    if (elements.help.open) { elements.help.open = false; elements.help.querySelector("summary").focus(); event.preventDefault(); }
  });
  document.addEventListener("click", async (event) => {
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank" || link.getAttribute("href").startsWith("#") || !hasDraft()) return;
    if (!desktopAvailable()) return;
    event.preventDefault();
    const href = link.href;
    if (await confirmDiscard() && desktopAvailable()) { clearTracking(); window.location.assign(href); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasDraft() && !busy) return;
    event.preventDefault();
    event.returnValue = "";
  });
  elements.export.addEventListener("click", async () => {
    if (!desktopAvailable() || exportController || busy || transitionPending) return;
    const controller = new AbortController();
    const status = elements.filter.value;
    const date = elements.date.value;
    const scope = `${elements.filter.selectedOptions[0].textContent} · ${date || "all pickup dates"}`;
    exportController = controller;
    updateBusyControls();
    clearFeedback();
    try {
      await exportOperatorBookings(status, controller.signal, date);
      if (desktopAvailable() && !controller.signal.aborted) showSuccess(`CSV downloaded: ${scope}, up to 100. Search is not applied. Keep customer data private.`);
    } catch (error) {
      if (desktopAvailable() && !controller.signal.aborted && error.name !== "AbortError") showError(elements.feedback, error.message || "The operator export could not be downloaded.");
    } finally {
      if (exportController === controller) exportController = null;
      if (desktopAvailable()) {
        updateBusyControls();
        if (document.activeElement === document.body && !elements.export.disabled) elements.export.focus({ preventScroll: true });
      }
    }
  });
}

export function suspendOperator() {
  captureDetailState();
  if ((detailState.note.length || editIsDirty()) && selectedId) suspendedDraft = { id: selectedId, note: detailState.note, edit: detailState.edit && editIsDirty() ? detailState.edit : null };
  enabled = false;
  workspaceVersion += 1;
  listRequestId += 1;
  detailRequestId += 1;
  clearTimeout(searchTimer);
  listController?.abort();
  detailController?.abort();
  exportController?.abort();
  cancelOperatorDialog();
  clearTracking();
  bookings = [];
  selectedId = null;
  selectedBooking = null;
  renderedId = null;
  lockMessage = "";
  listLoading = false;
  detailLoading = false;
  searchPending = false;
  hasPage = false;
  listFailed = false;
  filters = { status: "all", query: "", date: "", offset: 0 };
  page = { offset: 0, limit: PAGE_SIZE, total: 0, hasMore: false };
  detailState = { id: null, note: "", sections: new Set(), scroll: 0, tab: "overview" };
  lastQueueFocus = null;
  if (!elements) return;
  if (elements.drawer.open) elements.drawer.close();
  elements.drawerTabs.hidden = true;
  elements.list.innerHTML = "";
  elements.detail.innerHTML = renderDetailPlaceholder();
  elements.detail.removeAttribute("aria-busy");
  elements.list.removeAttribute("aria-busy");
  elements.empty.hidden = true;
  elements.help.open = false;
  syncFilterInputs();
  [elements.pending, elements.active, elements.unpaid, elements.collected].forEach((element) => { element.textContent = "—"; });
  elements.results.textContent = "Waiting for bookings";
  elements.pageInfo.textContent = "No results loaded";
  elements.updated.textContent = "Waiting for bookings";
  elements.mobileDraft.hidden = !suspendedDraft;
  updateBusyControls();
  clearFeedback();
}
