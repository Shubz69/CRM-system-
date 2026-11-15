/**
 * Who to send to for a conversation: its channel's provider and the contact's id on that
 * provider. Sending with a ManyChat id (or the internal contact id) on a Zernio / Meta
 * Instagram conversation fails or reaches the wrong account.
 */
export function resolveConversationRecipient(input: {
  provider?: string | null;
  identifiers: Array<{ channel: string; identifier: string }>;
  contactId: string;
}): { provider: string; contactExternalId: string } {
  const provider = input.provider || "manychat";
  const identifier =
    input.identifiers.find((i) => i.channel === provider) ||
    input.identifiers.find((i) => i.channel === "manychat") ||
    input.identifiers[0];
  if (!identifier) return { provider, contactExternalId: input.contactId };
  const prefix = `${identifier.channel}:`;
  return {
    provider,
    contactExternalId: identifier.identifier.startsWith(prefix)
      ? identifier.identifier.slice(prefix.length)
      : identifier.identifier,
  };
}
