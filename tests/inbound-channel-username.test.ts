import { describe, expect, it } from "vitest";
import {
  messagingChannelDisplayName,
  persistableChannelInstagramUsername,
  resolveChannelInstagramUsername,
} from "@/services/messaging/channel-identity";

describe("resolveChannelInstagramUsername", () => {
  it("uses the inbound handle and never invents demo_account", () => {
    expect(
      resolveChannelInstagramUsername({ contactUsername: "@shubzfx" }),
    ).toBe("shubzfx");
    expect(resolveChannelInstagramUsername({ contactUsername: null })).toBeNull();
    expect(
      resolveChannelInstagramUsername({
        contactUsername: null,
        existingUsername: "demo_account",
      }),
    ).toBeNull();
  });

  it("treats demo_account as absent so new orgs never keep that placeholder", () => {
    expect(resolveChannelInstagramUsername({ contactUsername: "demo_account" })).toBeNull();
    expect(
      resolveChannelInstagramUsername({
        contactUsername: "demo_account",
        existingUsername: "demo_account",
      }),
    ).toBeNull();
  });

  it("replaces a leftover demo_account placeholder when a live handle arrives", () => {
    expect(
      resolveChannelInstagramUsername({
        contactUsername: "shubzfx",
        existingUsername: "demo_account",
      }),
    ).toBe("shubzfx");
  });

  it("labels Zernio channels separately from ManyChat", () => {
    expect(messagingChannelDisplayName("zernio")).toBe("Instagram (Zernio)");
    expect(messagingChannelDisplayName("manychat")).toBe("Instagram via ManyChat");
    expect(messagingChannelDisplayName("meta_instagram")).toBe("Instagram (Meta)");
  });

  it("persistableChannelInstagramUsername never stores demo_account", () => {
    expect(persistableChannelInstagramUsername("demo_account")).toBeNull();
    expect(persistableChannelInstagramUsername("@demo_account")).toBeNull();
    expect(persistableChannelInstagramUsername("DEMO_ACCOUNT")).toBeNull();
    expect(persistableChannelInstagramUsername(null)).toBeNull();
    expect(persistableChannelInstagramUsername("@live_handle")).toBe("live_handle");
  });
});
