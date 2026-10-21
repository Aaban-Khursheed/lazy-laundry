import { applyVariants } from "../shared/variants.js";
import { setBookingLeadMinutes } from "../shared/utils.js";
import { initializeOperator, renderOperatorDashboard, suspendOperator } from "./modules/dashboard.js";

const desktop = window.matchMedia("(min-width: 1024px)");
const shell = document.querySelector("#operator-shell");
const guard = document.querySelector("#operator-desktop-required");

setBookingLeadMinutes(0);
applyVariants();

function updateWorkspace() {
  shell.hidden = !desktop.matches;
  guard.hidden = desktop.matches;
  if (desktop.matches) {
    initializeOperator();
    renderOperatorDashboard();
  } else {
    const restoreFocus = shell.contains(document.activeElement) || Boolean(document.querySelector(".operator-dialog[open]"));
    suspendOperator();
    if (restoreFocus) guard.querySelector("a").focus();
  }
}

desktop.addEventListener("change", updateWorkspace);
updateWorkspace();
