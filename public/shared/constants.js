export const PRICING = {
  10: { base: 29.99, express: 10, hanger: 0 },
  18: { base: 54.99, express: 15, hanger: 0 },
};

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
