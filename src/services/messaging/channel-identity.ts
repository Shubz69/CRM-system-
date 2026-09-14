import { MESSAGING_PROVIDER } from "@/services/messaging/providers";

/** Never invent a live handle. `demo_account` is a leftover placeholder, not @shubzfx. */
export function resolveChannelInstagramUsername(input: {
  contactUsername?: string | null;
  existingUsername?: string | null;
}): string | null {
  const live = input.contactUsername?.replace(/^@/, "").trim();
  if (live && live.toLowerCase() !== "demo_account") return live;
  const existing = input.existingUsername?.replace(/^@/, "").trim();
  if (existing && existing.toLowerCase() !== "demo_account") return existing;
  return null;
}

export function messagingChannelDisplayName(provider: string): string {
  if (provider === MESSAGING_PROVIDER.META_INSTAGRAM) return "Instagram (Meta)";
  if (provider === MESSAGING_PROVIDER.ZERNIO) return "Instagram (Zernio)";
  if (provider === MESSAGING_PROVIDER.MANYCHAT) return "Instagram via ManyChat";
  return "Instagram";
}
