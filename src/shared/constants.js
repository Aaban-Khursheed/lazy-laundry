// Canonical price table in sen — the Worker (api/worker.js) and the display
// PRICING map below both derive from this; do not duplicate values elsewhere.
export const PRICE_CENTS = {
  10: { base: 2999, express: 1000, hanger: 0 },
  18: { base: 5499, express: 1500, hanger: 0 },
};

// Display copy of the same table in RM.
export const PRICING = Object.fromEntries(
  Object.entries(PRICE_CENTS).map(([size, tier]) => [
    size,
    { base: tier.base / 100, express: tier.express / 100, hanger: tier.hanger / 100 },
  ]),
);

export const SERVICE_LABELS = {
  standard: "Lazy Wash",
  express: "Lazy Wash Express",
};

export const PAYMENT_LABELS = {
  cash: "Cash at pickup",
  qr: "QR at pickup",
};

export const STATUS_STEPS = [
  "Confirmed",
  "Pickup on the way",
  "Laundry picked up",
  "Processing",
  "Ready",
  "Delivered",
];

export const STATUS_CANCELLED = "Cancelled";

export const STATUS_ACTIONS = {
  Confirmed: "Confirm request",
  "Pickup on the way": "Mark pickup en route",
  "Laundry picked up": "Mark laundry picked up",
  Processing: "Start processing",
  Ready: "Mark ready for delivery",
  Delivered: "Mark delivered",
};
