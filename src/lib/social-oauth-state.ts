import { randomBytes } from "crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export type OAuthStatePayload = {
  organisationId: string;
  userId: string;
  platform: string;
  nonce: string;
  issuedAt: number;
};

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for a consent-screen round trip.

/**
 * Encrypted (AES-256-GCM, same key as every other stored secret) OAuth
 * `state` param — binds the callback to the organisation/user that started
 * the connect flow and expires quickly, so it can't be replayed or forged
 * into connecting a different tenant's account.
 */
export function createOAuthState(input: { organisationId: string; userId: string; platform: string }): string {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
  };
  return encryptSecret(JSON.stringify(payload));
}

export function verifyOAuthState(state: string): OAuthStatePayload | null {
  try {
    const payload = JSON.parse(decryptSecret(state)) as OAuthStatePayload;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    if (!payload.organisationId || !payload.userId || !payload.platform) return null;
    return payload;
  } catch {
    return null;
  }
}
