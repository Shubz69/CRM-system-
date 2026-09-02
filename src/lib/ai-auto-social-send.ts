/**
 * Beta/production policy: AI must not auto-send on social channels.
 * Only explicit env enablement may bypass the hard gate (platform/ops only).
 * Normal workspace users have no UI to enable this.
 */
export function isAiAutoSocialSendEnabled(): boolean {
  const raw = (process.env.AI_AUTO_SOCIAL_SEND || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "enabled" || raw === "on";
}

export const AI_AUTO_SOCIAL_SEND_DISABLED_REASON =
  "AI social outbound requires human approval (AI_AUTO_SOCIAL_SEND disabled).";
