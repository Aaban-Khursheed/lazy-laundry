let users = 0;
let originalFetch;
let blocked = 0;

export function blockOutbound() {
  if (users === 0) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      blocked += 1;
      throw new Error("Outbound HTTP blocked by Liberait test profile");
    };
  }
  users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) globalThis.fetch = originalFetch;
  };
}

export function blockedAttempts() {
  return blocked;
}
