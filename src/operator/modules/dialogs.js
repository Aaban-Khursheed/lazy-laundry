import { escapeHtml, getMaxBookingDateString, getSlotsForDate, getTodayString, isSlotClosed } from "../../shared/utils.js";
import { buttonVariants } from "../../shared/variants.js";
import { getEligibility } from "./components.js";

let activeDialog = null;

const actionDefinitions = {
  advance: { title: "Update order status?", submit: "Update status", description: "Move this order to the next lifecycle step. This change is recorded in the order history." },
  cancel: { title: "Cancel this booking?", submit: "Cancel booking", description: "This releases the pickup slot. Allocated fees return to the customer account; cancellation itself does not add a fee.", reason: true, danger: true },
  no_show: { title: "Record a no-show?", submit: "Record no-show", description: "This cancels the booking and adds the disclosed RM3 incident to the customer account. Only record this after the pickup opportunity has elapsed.", reason: true, danger: true },
  reopen: { title: "Reopen this booking?", submit: "Reopen booking", description: "Choose a pickup date and scheduled slot in Malaysia time. Reopening clears allocated fees on this order; the server checks current availability.", reason: true, schedule: true },
  paid: { title: "Confirm payment collected", submit: "Record collection", description: "Confirm you have received the full order total. This records payment and settles allocated fees; it does not charge the customer." },
  waive: { title: "Waive this fee?", submit: "Waive fee", description: "The selected incident will be waived. Outstanding balance or unpaid allocated fees are adjusted by the server. A specific audit reason is required.", reason: true, danger: true },
  share: { title: "Generate a private share link?", submit: "Show link", description: "This retrieves the current customer tracking credential and records sharing in the audit log. Only send it through a verified private channel." },
  rotate: { title: "Replace the tracking link?", submit: "Rotate link", description: "The old link will stop working immediately. A new private customer link will be shown in this workspace.", reason: true, danger: true },
  revoke: { title: "Revoke the tracking link?", submit: "Revoke link", description: "Anyone with the existing link loses tracking access. You must rotate the link before it can be shared again.", reason: true, danger: true },
};

export function cancelOperatorDialog() {
  if (activeDialog?.open) activeDialog.close("cancel");
}

export function requestOperatorDialog({ title, description, submit = "Confirm", cancel = "Keep unchanged", eyebrow = "Audited operator action", context = "", reason = false, schedule = false, danger = false, booking = {} }) {
  if (activeDialog || !window.matchMedia("(min-width: 1024px)").matches) return Promise.resolve(null);
  const returnFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "operator-dialog";
  dialog.setAttribute("aria-labelledby", "operator-dialog-title");
  dialog.setAttribute("aria-describedby", "operator-dialog-description");
  dialog.innerHTML = `<form class="operator-dialog-form" novalidate>
    <div class="operator-dialog-header"><span class="eyebrow">${escapeHtml(eyebrow)}</span><button type="button" class="${escapeHtml(buttonVariants({ intent: "ghost", size: "sm" }))}" data-dialog-cancel aria-label="Close dialog">Close</button></div>
    <h2 id="operator-dialog-title">${escapeHtml(title)}</h2><p class="operator-dialog-context">${escapeHtml(context)}</p><p id="operator-dialog-description">${escapeHtml(description)}</p>
    ${schedule ? `<div class="operator-dialog-schedule"><div><label for="operator-dialog-date">Pickup date · MYT</label><input class="text-input" id="operator-dialog-date" name="pickupDate" type="date" min="${escapeHtml(getTodayString())}" max="${escapeHtml(getMaxBookingDateString())}" required /></div><div><label for="operator-dialog-slot">Pickup slot · MYT</label><select class="text-input" id="operator-dialog-slot" name="pickupSlot" required></select></div></div>` : ""}
    ${reason ? '<label for="operator-dialog-reason">Audit reason <span class="operator-dialog-required">Required</span></label><textarea class="text-input" id="operator-dialog-reason" name="reason" rows="3" required maxlength="500" placeholder="Explain why this change is needed"></textarea><p class="operator-help">1–500 characters. Plain text; do not include tracking credentials.</p>' : ""}
    <p class="form-error" id="operator-dialog-error" role="alert" hidden></p><div class="operator-dialog-footer"><button type="button" class="${escapeHtml(buttonVariants({ intent: "secondary", size: "md" }))}" data-dialog-cancel>${escapeHtml(cancel)}</button><button type="submit" class="${escapeHtml(buttonVariants({ intent: danger ? "danger" : "primary", size: "md" }))}">${escapeHtml(submit)}</button></div>
  </form>`;
  document.body.append(dialog);
  activeDialog = dialog;
  return new Promise((resolve) => {
    let result = null;
    const form = dialog.querySelector("form");
    const error = dialog.querySelector("#operator-dialog-error");
    const date = dialog.querySelector("#operator-dialog-date");
    const slot = dialog.querySelector("#operator-dialog-slot");
    const reasonInput = dialog.querySelector("#operator-dialog-reason");
    const fail = (message, input) => {
      error.textContent = message;
      error.hidden = false;
      input?.focus();
    };
    const updateSlots = () => {
      const current = slot.value || booking.pickupSlot;
      slot.innerHTML = getSlotsForDate(date.value).map((value) => `<option value="${escapeHtml(value)}"${isSlotClosed(date.value, value) ? " disabled" : ""}>${escapeHtml(value)} MYT</option>`).join("");
      if ([...slot.options].some((option) => option.value === current && !option.disabled)) slot.value = current;
      else slot.value = [...slot.options].find((option) => !option.disabled)?.value || "";
    };
    if (schedule) {
      const today = getTodayString();
      date.value = booking.pickupDate >= today && booking.pickupDate <= getMaxBookingDateString() ? booking.pickupDate : today;
      updateSlots();
      date.addEventListener("change", updateSlots);
    }
    dialog.querySelectorAll("[data-dialog-cancel]").forEach((button) => button.addEventListener("click", () => dialog.close("cancel")));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dialog.close("cancel");
    });
    let backdropDown = false;
    const outsideDialog = (event) => {
      const bounds = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
    };
    dialog.addEventListener("pointerdown", (event) => { backdropDown = outsideDialog(event); });
    dialog.addEventListener("click", (event) => {
      if (backdropDown && outsideDialog(event)) dialog.close("cancel");
      backdropDown = false;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.hidden = true;
      const trimmedReason = reasonInput?.value.trim() || "";
      if (reason && (!trimmedReason || trimmedReason.length > 500)) {
        fail("Enter an audit reason between 1 and 500 characters.", reasonInput);
        return;
      }
      if (schedule && (!date.validity.valid || !slot.value || !getSlotsForDate(date.value).includes(slot.value) || isSlotClosed(date.value, slot.value))) {
        fail("Choose an available scheduled slot within the next 7 days.", date);
        return;
      }
      result = { ...(reason ? { reason: trimmedReason } : {}), ...(schedule ? { pickupDate: date.value, pickupSlot: slot.value } : {}) };
      dialog.close("submit");
    });
    dialog.addEventListener("close", () => {
      if (activeDialog === dialog) activeDialog = null;
      dialog.remove();
      if (returnFocus?.isConnected && !returnFocus.closest("[hidden]")) returnFocus.focus();
      resolve(result);
    }, { once: true });
    dialog.showModal();
    (reasonInput || date || dialog.querySelector("[data-dialog-cancel]")).focus();
  });
}

export async function requestDiscardDialog(kind = "note") {
  const edits = kind === "edit";
  const result = await requestOperatorDialog({
    title: edits ? "Discard unsaved changes?" : "Discard unsaved note?",
    description: edits
      ? "The booking form has unsaved changes. Stay to keep editing, or discard them before leaving this order."
      : "This note has not been saved. Stay to keep editing, or discard it before leaving this order.",
    submit: edits ? "Discard changes" : "Discard note",
    cancel: "Keep editing",
    eyebrow: "Unsaved changes",
    danger: true,
  });
  return result !== null;
}

export function requestActionDialog(action, booking, penalty = null) {
  const definition = actionDefinitions[action];
  if (!definition) return Promise.resolve(null);
  if (["advance", "cancel", "no_show", "reopen", "paid"].includes(action) && !getEligibility(booking)[action]) return Promise.resolve(null);
  const context = `${booking.number || "Booking"} · ${booking.name || "Unnamed booking"}${action === "paid" ? ` · RM${(Number(booking.total) || 0).toFixed(2)}` : ""}${penalty ? ` · Fee RM${(Number(penalty.amount) || 0).toFixed(2)}` : ""}`;
  const description = action === "advance" ? `Move this order from ${booking.status} to ${getEligibility(booking).nextStatus}. This change is recorded in the order history.` : definition.description;
  return requestOperatorDialog({ ...definition, description, booking, context });
}
