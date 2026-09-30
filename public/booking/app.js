import { API_MODE } from "./modules/api.js";
import { initializeBooking, resetBookingForm } from "./modules/booking.js";
import { initializeOperator, renderOperatorDashboard } from "./modules/operator.js";
import {
  initializeTracking,
  prepareTrackingView,
  renderConfirmation,
} from "./modules/tracking.js";

const views = [...document.querySelectorAll(".view")];

function showView(viewId) {
  views.forEach((view) => {
    view.classList.toggle("hidden", view.id !== viewId);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function configureApiModeCopy() {
  if (!API_MODE) {
    return;
  }

  const homeNotice = document.querySelector("#home-view .prototype-notice");
  homeNotice.querySelector("strong").textContent = "Staging API mode";
  homeNotice.querySelector("span").textContent = "Requests use a staging API, separate from the live service. Public intake is disabled by default; enabled test requests reserve slots in staging only.";

  const bookingNotice = document.querySelector("#booking-view .prototype-notice");
  bookingNotice.querySelector("strong").textContent = "Staging request only";
  bookingNotice.querySelector("span").textContent = "This form sends requests to the staging API. Public intake is disabled by default; enabled test requests reserve slots in staging only, not the live service.";

  const operatorNotice = document.querySelector("#operator-view .operator-notice");
  operatorNotice.querySelector("strong").textContent = "Staging operator API";
  operatorNotice.querySelector("span").textContent = "Operator actions use the Access-protected staging API. Access configuration is required; public booking remains disabled until manually enabled.";

  const submitButton = document.querySelector("#booking-form .submit-button");
  submitButton.firstChild.textContent = "Submit staging request\n              ";
  document.querySelector(".payment-note").textContent = "No payment is taken; staging requests are not live bookings.";
  document.querySelector("#operator-view .view-heading .eyebrow").textContent = "Staging API workflow";
  document.querySelector("#operator-view .admin-empty span").textContent = "Bookings returned by the staging operator API will appear here.";
  const ownerLink = document.querySelector(".owner-link");
  if (ownerLink) ownerLink.textContent = "Operator workflow";
}

function setupViewNavigation() {
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.viewTarget;
      if (target === "booking-view" && !button.dataset.preserveBooking) {
        resetBookingForm();
      }
      if (target === "tracking-view") {
        prepareTrackingView();
      }
      if (target === "operator-view") {
        renderOperatorDashboard();
      }
      showView(target);
    });
  });
}

configureApiModeCopy();
initializeBooking({
  showView,
  onBookingCreated(booking, trackingToken) {
    renderConfirmation(booking, trackingToken);
    showView("confirmation-view");
  },
});
initializeTracking();
initializeOperator();
setupViewNavigation();
