import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRM_SUBNAV, GROWTH_SUBNAV } from "@/lib/navigation";

const root = join(__dirname, "..");

describe("section subnav product design", () => {
  it("uses readable active styles — never blank dark pills", () => {
    const src = readFileSync(join(root, "src/components/section-subnav.tsx"), "utf8");
    expect(src).toContain("data-active");
    expect(src).toContain("aria-current");
    expect(src).toContain("bg-[var(--accent-soft)]");
    expect(src).toContain("text-[var(--accent)]");
    expect(src).not.toMatch(/bg-\[var\(--sidebar\)\].*text-white/);
    expect(src).toContain("section-subnav-switcher");
    expect(src).toContain("lg:hidden");
    expect(src).toMatch(/hidden[\s\S]*lg:flex/);
  });

  it("covers CRM and Growth destinations for responsive switchers", () => {
    expect(CRM_SUBNAV.length).toBeGreaterThanOrEqual(4);
    expect(GROWTH_SUBNAV.length).toBeGreaterThanOrEqual(5);
    expect(CRM_SUBNAV.every((i) => i.label.trim().length > 0)).toBe(true);
    expect(GROWTH_SUBNAV.every((i) => i.label.trim().length > 0)).toBe(true);
  });
});

describe("desktop header chrome", () => {
  it("keeps Menu button mobile-only and search field without redundant desktop icon button", () => {
    const src = readFileSync(join(root, "src/components/app-shell.tsx"), "utf8");
    expect(src).toMatch(/lg:hidden/);
    expect(src).toContain("Open navigation menu");
    // Full search field on sm+; icon-only search only below sm (wrapper, not .btn + utility)
    expect(src).toContain("Search Agent Desk");
    expect(src).toMatch(/sm:hidden/);
    expect(src).toContain('aria-label="Open search"');
  });
});

describe("customer metric label accuracy", () => {
  it("labels pipeline stage configuration separately from commercial pipeline value", () => {
    const src = readFileSync(join(root, "src/app/(app)/crm/page.tsx"), "utf8");
    expect(src).toContain("Pipeline stages");
    expect(src).toContain("Open pipeline value");
    expect(src).not.toMatch(/title="Open pipeline"/);
  });
});

describe("empty inbox mode", () => {
  it("centres onboarding when there are no conversations", () => {
    const src = readFileSync(join(root, "src/app/(app)/inbox/inbox-client.tsx"), "utf8");
    expect(src).toContain("items.length === 0");
    expect(src).toContain("Connect messaging to open your inbox");
    expect(src).toContain("Connect Instagram");
  });
});

describe("technical copy absence on customer Learning", () => {
  it("does not render eng eval controls on Analytics Learning", () => {
    const src = readFileSync(join(root, "src/app/(app)/learning/page.tsx"), "utf8");
    expect(src).not.toMatch(/Brier/);
    expect(src).not.toMatch(/system prompt/i);
    expect(src).not.toMatch(/Run quality checks/);
    expect(src).not.toMatch(/Agent version candidates/);
    expect(src).toMatch(/What is changing/);
    expect(src).toMatch(/What seems to work/);
  });

  it("keeps eng learning controls under Admin Learning Lab", () => {
    const src = readFileSync(join(root, "src/app/(app)/admin/learning-lab/page.tsx"), "utf8");
    expect(src).toMatch(/Learning Lab/);
    expect(src).toMatch(/Run quality checks/);
  });
});
