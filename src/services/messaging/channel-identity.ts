import { MESSAGING_PROVIDER } from "@/services/messaging/providers";

export const DEMO_ACCOUNT_PLACEHOLDER = "demo_account";

export function isDemoAccountPlaceholder(value?: string | null): boolean {
  return (value ?? "").replace(/^@/, "").trim().toLowerCase() === DEMO_ACCOUNT_PLACEHOLDER;
}

/** Never invent a live handle. `demo_account` is a leftover placeholder, not @shubzfx. */
export function resolveChannelInstagramUsername(input: {
  contactUsername?: string | null;
  existingUsername?: string | null;
}): string | null {
  const live = input.contactUsername?.replace(/^@/, "").trim();
  if (live && !isDemoAccountPlaceholder(live)) return live;
  const existing = input.existingUsername?.replace(/^@/, "").trim();
  if (existing && !isDemoAccountPlaceholder(existing)) return existing;
  return null;
}

/** Value stored on MessagingChannel.instagramUsername — never demo_account. */
export function persistableChannelInstagramUsername(
  username?: string | null,
): string | null {
  return resolveChannelInstagramUsername({ contactUsername: username });
}

export function messagingChannelDisplayName(provider: string): string {
  if (provider === MESSAGING_PROVIDER.META_INSTAGRAM) return "Instagram (Meta)";
  if (provider === MESSAGING_PROVIDER.ZERNIO) return "Instagram (Zernio)";
  if (provider === MESSAGING_PROVIDER.MANYCHAT) return "Instagram via ManyChat";
  return "Instagram";
}
