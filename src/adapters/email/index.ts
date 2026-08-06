import type { EmailAdapter, EmailDeliveryInput, EmailDeliveryResult } from "./types";
import { mockEmailLog } from "./types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export class MockEmailAdapter implements EmailAdapter {
  readonly name = "email-mock";

  async send(input: EmailDeliveryInput): Promise<EmailDeliveryResult> {
    const messageId = `mock_email_${Date.now()}`;
    mockEmailLog.push({ ...input, sentAt: new Date().toISOString() });
    logger.info("Mock email recorded", { to: input.to, subject: input.subject, messageId });
    return { ok: true, provider: this.name, messageId };
  }
}

/**
 * SMTP skeleton — only activates when EMAIL_SMTP_URL is set.
 * Without a verified nodemailer/SMTP stack we fail closed rather than invent transport.
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = "smtp";

  async send(input: EmailDeliveryInput): Promise<EmailDeliveryResult> {
    const env = getEnv();
    if (!env.EMAIL_SMTP_URL) {
      return new MockEmailAdapter().send(input);
    }
    return {
      ok: false,
      provider: this.name,
      error:
        "Live SMTP delivery requires a mail transport dependency. Credentials/URL are present but live send is not enabled in this build — use mock email or wire nodemailer.",
    };
  }
}

export function getEmailAdapter(): EmailAdapter {
  const env = getEnv();
  if (env.EMAIL_SMTP_URL) return new SmtpEmailAdapter();
  return new MockEmailAdapter();
}

export { clearMockEmailLog, mockEmailLog } from "./types";
