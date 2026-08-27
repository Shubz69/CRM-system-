/**
 * Messaging → business-value attribution hooks.
 *
 * No safe write API exists on business-value helpers to invent revenue from
 * conversation events. Attribution contribution is therefore UNKNOWN until a
 * directly evidenced CostOutcomeLink / DecisionOutcome is recorded elsewhere.
 */

export type MessagingValueContribution = {
  attribution: "UNKNOWN";
  note: string;
};

/** Record an honest UNKNOWN contribution — does not invent measured revenue. */
export async function recordMessagingValueContribution(_input: {
  organisationId: string;
  conversationId: string;
  contactId?: string;
  messageId?: string;
  reason?: string;
}): Promise<MessagingValueContribution> {
  void _input;
  return {
    attribution: "UNKNOWN",
    note: "UNKNOWN: messaging events do not invent revenue; wait for evidenced outcomes.",
  };
}
