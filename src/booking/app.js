import { applyVariants } from "../shared/variants.js";
import { apiRequest } from "../shared/api.js";
import { initializeBooking, isBookingLocked, refreshBookingWindow, resetBookingForm, setBookingEnabled } from "./modules/booking.js";
import {
  initializeTracking,
  isTrackingBusy,
  prepareTrackingView,
  refreshTrackingWindow,
  renderConfirmation,
} from "./modules/tracking.js";

const views = [...document.querySelectorAll(".view")];
const entryButton = document.querySelector("#booking-entry-button");
const entryLabel = document.querySelector("#booking-entry-label");
const configRetry = document.querySelector("#booking-config-retry");
let bookingEnabled = false;
let configLoading = false;

function showView(viewId) {
  if (viewId === "booking-view" || viewId === "checkout-view") refreshBookingWindow();
  if (viewId === "tracking-view") refreshTrackingWindow();
  views.forEach((view) => {
    const hidden = view.id !== viewId;
    view.classList.toggle("hidden", hidden);
    view.hidden = hidden;
  });
  const target = document.getElementById(viewId);
  if (target) {
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

async function applyPublicConfig() {
  if (configLoading) return;
  configLoading = true;
  bookingEnabled = false;
  setBookingEnabled(false);
  entryButton.disabled = true;
  entryLabel.textContent = "Checking booking availability…";
  configRetry.disabled = true;
  configRetry.hidden = true;
  entryButton.setAttribute("aria-busy", "true");
  const stateMessage = document.querySelector("#booking-state-message");
  stateMessage.querySelector("strong").textContent = "Checking booking availability";
  stateMessage.querySelector("span").textContent = "Please wait while the service configuration is verified. Tracking remains available.";
  try {
    const config = await apiRequest("/api/config", { readOnly: true });
    if (typeof config?.bookingEnabled !== "boolean" || !(config.turnstileSiteKey === null || typeof config.turnstileSiteKey === "string")) {
      throw new Error("The service configuration could not be verified.");
    }
    bookingEnabled = config.bookingEnabled;
    setBookingEnabled(bookingEnabled);
    entryLabel.textContent = bookingEnabled ? "Make a booking" : "Bookings paused";
    stateMessage.querySelector("strong").textContent = bookingEnabled ? "Edumetro, USJ 1 service area" : "Bookings are temporarily paused";
    stateMessage.querySelector("span").textContent = bookingEnabled
      ? "Bookings are confirmed only when the server reserves the selected pickup slot."
      : "Tracking remains available. Please check back when pickup intake reopens.";
    document.querySelector("#booking-disabled-message").hidden = bookingEnabled;
  } catch {
    entryLabel.textContent = "Booking availability unverified";
    stateMessage.querySelector("strong").textContent = "Booking availability could not be verified";
    stateMessage.querySelector("span").textContent = "Bookings remain disabled. Retry booking availability to reconnect; tracking remains available.";
    configRetry.hidden = false;
  } finally {
    configLoading = false;
    configRetry.disabled = false;
    entryButton.disabled = !bookingEnabled || isBookingLocked() || isTrackingBusy();
    entryButton.removeAttribute("aria-busy");
  }
}

function setupViewNavigation() {
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      if (isBookingLocked() || isTrackingBusy()) return;
      const target = button.dataset.viewTarget;
      if ((target === "booking-view" || target === "checkout-view") && !bookingEnabled) return;
      if (target === "booking-view" && !button.dataset.preserveBooking) {
        if (!resetBookingForm()) return;
      }
      if (target === "tracking-view") prepareTrackingView();
      showView(target);
    });
  });
  document.querySelector(".brand").addEventListener("click", (event) => {
    if (isBookingLocked() || isTrackingBusy()) event.preventDefault();
  });
  configRetry.addEventListener("click", applyPublicConfig);
  document.addEventListener("customer-controls-changed", () => {
    entryButton.disabled = !bookingEnabled || isBookingLocked() || isTrackingBusy();
  });
}

applyVariants();
initializeBooking({
  showView,
  onBookingCreated(booking, trackingToken) {
    renderConfirmation(booking, trackingToken);
    showView("confirmation-view");
  },
});
initializeTracking();
setupViewNavigation();
applyPublicConfig();

function captureTrackingLocation() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("token");
  const number = fragment.get("number");
  if (token) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (isBookingLocked() || isTrackingBusy()) return;
    prepareTrackingView(token, number);
    showView("tracking-view");
  } else if (/^\/track\/?$/.test(window.location.pathname)) {
    showView("tracking-view");
  }
}

captureTrackingLocation();
window.addEventListener("hashchange", captureTrackingLocation);
