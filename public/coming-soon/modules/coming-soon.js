const launchAt = Date.parse("2026-09-30T22:50:27+08:00");
const countdownStatus = document.querySelector("#countdown-status");
const countdownValues = {
  days: document.querySelector("#countdown-days"),
  hours: document.querySelector("#countdown-hours"),
  minutes: document.querySelector("#countdown-minutes"),
  seconds: document.querySelector("#countdown-seconds"),
};

function updateCountdown() {
  const totalSeconds = Math.max(0, Math.floor((launchAt - Date.now()) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  countdownValues.days.textContent = String(days).padStart(2, "0");
  countdownValues.hours.textContent = String(hours).padStart(2, "0");
  countdownValues.minutes.textContent = String(minutes).padStart(2, "0");
  countdownValues.seconds.textContent = String(seconds).padStart(2, "0");

  if (totalSeconds === 0) {
    countdownStatus.textContent = "The countdown is complete. Launch details will be posted here.";
    return false;
  }
  return true;
}

if (updateCountdown()) {
  const timer = window.setInterval(() => {
    if (!updateCountdown()) {
      window.clearInterval(timer);
    }
  }, 1000);
}
