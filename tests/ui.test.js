import { describe, expect, it } from "vitest";
import { applyVariants, badgeVariants, buttonVariants, surfaceVariants } from "../ui/variants.js";

function variantElement(dataset, className = "") {
  return {
    dataset,
    className,
    get classList() { return this.className.split(" ").filter(Boolean); },
  };
}

describe("shared CVA components", () => {
  it("provides consistent button defaults", () => {
    expect(buttonVariants()).toBe("ui-button ui-button--primary ui-button--md ui-button--auto");
  });

  it("composes intent, size, width and caller classes", () => {
    expect(buttonVariants({ intent: "danger", size: "lg", width: "full", className: "cancel-pickup" }))
      .toBe("ui-button ui-button--danger ui-button--lg ui-button--full cancel-pickup");
    expect(buttonVariants({ intent: "ghost", size: "sm" })).toContain("ui-button--quiet");
  });

  it("keeps status tones and panel spacing independently configurable", () => {
    expect(badgeVariants({ tone: "success" })).toBe("ui-badge ui-badge--success");
    expect(surfaceVariants({ tone: "tinted", padding: "lg" })).toBe("ui-surface ui-surface--tinted ui-surface--lg");
  });

  it("updates declarative variants without accumulating stale classes", () => {
    const button = variantElement({ ui: "button", intent: "primary", size: "sm" }, "operator-refresh");
    const root = { querySelectorAll: () => [button] };
    applyVariants(root);
    applyVariants(root);
    expect(button.className.match(/ui-button--primary/g)).toHaveLength(1);
    button.dataset.intent = "danger";
    applyVariants(root);
    expect(button.className).toContain("operator-refresh");
    expect(button.className).toContain("ui-button--danger");
    expect(button.className).not.toContain("ui-button--primary");
  });

  it("ignores unknown component names", () => {
    const elements = ["unsupported", "constructor", "__proto__"].map((ui) => variantElement({ ui }, "unchanged"));
    applyVariants({ querySelectorAll: () => elements });
    elements.forEach((element) => expect(element.className).toBe("unchanged"));
  });
});
