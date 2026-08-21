import nodemailer from "nodemailer";
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
 * Real SMTP via nodemailer when EMAIL_SMTP_URL is set.
 * URL shapes: smtp://user:pass@host:587 or smtps://user:pass@host:465
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = "smtp";

  async send(input: EmailDeliveryInput): Promise<EmailDeliveryResult> {
    const env = getEnv();
    if (!env.EMAIL_SMTP_URL) {
      return new MockEmailAdapter().send(input);
    }

    let parsed: URL;
    try {
      parsed = new URL(env.EMAIL_SMTP_URL);
    } catch {
      return { ok: false, provider: this.name, error: "EMAIL_SMTP_URL is not a valid URL" };
    }

    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "smtps:"
        ? 465
        : 587;
    const secure = parsed.protocol === "smtps:" || port === 465;
    const user = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const pass = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const transporter = nodemailer.createTransport({
      host: parsed.hostname,
      port,
      secure,
      auth: user ? { user, pass: pass || "" } : undefined,
    });

    const from = env.EMAIL_FROM || user || "noreply@localhost";
    try {
      const info = await transporter.sendMail({
        from,
        to: input.to.join(", "),
        subject: input.subject,
        text: input.bodyText,
      });
      return {
        ok: true,
        provider: this.name,
        messageId: typeof info.messageId === "string" ? info.messageId : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "SMTP send failed";
      logger.error("SMTP email send failed", { message, to: input.to });
      return { ok: false, provider: this.name, error: message };
    }
  }
}

export function getEmailAdapter(): EmailAdapter {
  const env = getEnv();
  if (env.EMAIL_SMTP_URL) return new SmtpEmailAdapter();
  return new MockEmailAdapter();
}

export { clearMockEmailLog, mockEmailLog } from "./types";
