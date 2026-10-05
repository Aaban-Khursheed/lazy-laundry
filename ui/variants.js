import { cva } from "class-variance-authority";

export const buttonVariants = cva("ui-button", {
  variants: {
    intent: {
      primary: "ui-button--primary",
      secondary: "ui-button--secondary",
      danger: "ui-button--danger",
      ghost: "ui-button--ghost",
    },
    size: {
      sm: "ui-button--sm",
      md: "ui-button--md",
      lg: "ui-button--lg",
    },
    width: { auto: "ui-button--auto", full: "ui-button--full" },
  },
  compoundVariants: [
    { intent: "ghost", size: "sm", class: "ui-button--quiet" },
  ],
  defaultVariants: { intent: "primary", size: "md", width: "auto" },
});

export const badgeVariants = cva("ui-badge", {
  variants: {
    tone: {
      neutral: "ui-badge--neutral",
      success: "ui-badge--success",
      warning: "ui-badge--warning",
      info: "ui-badge--info",
      danger: "ui-badge--danger",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const surfaceVariants = cva("ui-surface", {
  variants: {
    tone: {
      plain: "ui-surface--plain",
      tinted: "ui-surface--tinted",
      paper: "ui-surface--paper",
    },
    padding: {
      sm: "ui-surface--sm",
      md: "ui-surface--md",
      lg: "ui-surface--lg",
    },
  },
  defaultVariants: { tone: "plain", padding: "md" },
});

const variants = { button: buttonVariants, badge: badgeVariants, surface: surfaceVariants };

export function applyVariants(root = document) {
  const elements = [...root.querySelectorAll("[data-ui]")];
  if (root.matches?.("[data-ui]")) elements.unshift(root);
  elements.forEach((element) => {
    const { ui, intent, size, width, tone, padding } = element.dataset;
    if (!Object.hasOwn(variants, ui)) return;
    const prefix = `ui-${ui}`;
    const className = [...element.classList].filter((value) => value !== prefix && !value.startsWith(`${prefix}--`)).join(" ");
    element.className = variants[ui]({ intent, size, width, tone, padding, className });
  });
}
