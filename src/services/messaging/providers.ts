/** Canonical messaging provider identifiers (MessagingChannel.provider). */
export const MESSAGING_PROVIDER = {
  MANYCHAT: "manychat",
  META_INSTAGRAM: "meta_instagram",
  ZERNIO: "zernio",
} as const;

export type MessagingProviderId =
  (typeof MESSAGING_PROVIDER)[keyof typeof MESSAGING_PROVIDER];

export const META_INSTAGRAM_MESSAGING_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
] as const;

export const META_INSTAGRAM_WEBHOOK_FIELDS = ["messages", "messaging_postbacks"] as const;

export const META_INSTAGRAM_OAUTH_PURPOSE = "meta_instagram_messaging";

export function isMetaInstagramProvider(provider: string | null | undefined): boolean {
  return provider === MESSAGING_PROVIDER.META_INSTAGRAM;
}

export function isZernioMessagingProvider(provider: string | null | undefined): boolean {
  return provider === MESSAGING_PROVIDER.ZERNIO;
}

/** Providers that forbid cold DM — require prior inbound on the conversation. */
export function providerRequiresPriorInbound(provider: string | null | undefined): boolean {
  return isMetaInstagramProvider(provider) || isZernioMessagingProvider(provider);
}

export function metaInstagramIdentifier(igsid: string): string {
  return `${MESSAGING_PROVIDER.META_INSTAGRAM}:${igsid}`;
}

export function zernioContactIdentifier(externalContactId: string): string {
  return `${MESSAGING_PROVIDER.ZERNIO}:${externalContactId}`;
}

export function stripProviderPrefix(identifier: string, provider: string): string {
  const prefix = `${provider}:`;
  return identifier.startsWith(prefix) ? identifier.slice(prefix.length) : identifier;
}
