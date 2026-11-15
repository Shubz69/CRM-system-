import { randomBytes, timingSafeEqual } from "crypto";
import { IntegrationType } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/db";

/**
 * Per-workspace booking webhook secrets.
 *
 * The booking webhook used to accept one global BOOKING_WEBHOOK_SECRET for every
 * workspace and trust the organisationId in the body, so any tenant told that secret
 * could create bookings, move stages and cancel follow-ups in another workspace.
 *
 * Now: a workspace with its own secret accepts only that secret. Workspaces that have
 * not generated one keep working with the global secret (so connected booking tools
 * don't break on deploy) until BOOKING_WEBHOOK_REQUIRE_ORG_SECRET=true turns it off.
 */

const CREDENTIAL_KEY = "webhook_secret";
const INTEGRATION_NAME = "default";

function secretsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function globalBookingSecretAccepted(): boolean {
  return process.env.BOOKING_WEBHOOK_REQUIRE_ORG_SECRET !== "true";
}

/** True when the presented secret is the (still accepted) shared booking secret. */
export function matchesSharedBookingSecret(presented: string): boolean {
  return (
    Boolean(presented) &&
    globalBookingSecretAccepted() &&
    secretsEqual(presented, getEnv().BOOKING_WEBHOOK_SECRET)
  );
}

export async function getOrganisationBookingSecret(organisationId: string): Promise<string | null> {
  const integration = await prisma.integration.findUnique({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.BOOKING,
        name: INTEGRATION_NAME,
      },
    },
    include: { credentials: true },
  });
  const cred = integration?.credentials.find((c) => c.keyName === CREDENTIAL_KEY);
  if (!cred) return null;
  try {
    return decryptSecret(cred.encryptedValue);
  } catch {
    return null;
  }
}

export async function regenerateOrganisationBookingSecret(organisationId: string): Promise<string> {
  if (!organisationId) throw new Error("organisationId is required");
  const integration = await prisma.integration.upsert({
    where: {
      organisationId_type_name: {
        organisationId,
        type: IntegrationType.BOOKING,
        name: INTEGRATION_NAME,
      },
    },
    create: {
      organisationId,
      type: IntegrationType.BOOKING,
      name: INTEGRATION_NAME,
      isActive: true,
      config: {},
    },
    update: { isActive: true },
  });
  if (integration.organisationId !== organisationId) {
    throw new Error("Integration tenant mismatch");
  }
  const secret = `bk_${randomBytes(24).toString("hex")}`;
  await prisma.integrationCredential.upsert({
    where: { integrationId_keyName: { integrationId: integration.id, keyName: CREDENTIAL_KEY } },
    create: {
      integrationId: integration.id,
      keyName: CREDENTIAL_KEY,
      encryptedValue: encryptSecret(secret),
    },
    update: { encryptedValue: encryptSecret(secret) },
  });
  return secret;
}

export type BookingSecretCheck =
  | { ok: true; source: "organisation" | "global" }
  | { ok: false; reason: string };

/** Verify the secret presented for a booking webhook aimed at `organisationId`. */
export async function verifyBookingWebhookSecret(input: {
  organisationId: string;
  presented: string;
}): Promise<BookingSecretCheck> {
  if (!input.presented) return { ok: false, reason: "Missing webhook secret" };
  const orgSecret = await getOrganisationBookingSecret(input.organisationId);
  if (orgSecret) {
    return secretsEqual(input.presented, orgSecret)
      ? { ok: true, source: "organisation" }
      : { ok: false, reason: "Invalid webhook secret" };
  }
  if (!globalBookingSecretAccepted()) {
    return {
      ok: false,
      reason: "This workspace has no booking webhook secret yet — generate one in Integrations",
    };
  }
  return secretsEqual(input.presented, getEnv().BOOKING_WEBHOOK_SECRET)
    ? { ok: true, source: "global" }
    : { ok: false, reason: "Invalid webhook secret" };
}
