export const PRICING = {
  10: { base: 34.99, express: 10, hanger: 3 },
  18: { base: 59.99, express: 15, hanger: 5 },
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
  "Booking received",
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
