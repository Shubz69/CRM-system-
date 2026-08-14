/** True when a message looks like a leaked ORM/SQL/driver error. */
export function looksLikeRawDatabaseError(message: string): boolean {
  return /prisma|foreign key|constraint|invocation|P\d{4}|ECONNREFUSED|SQLSTATE|invalid `prisma/i.test(
    message,
  );
}

/**
 * Map unknown errors to plain-English Ask API copy. Never returns Prisma/SQL text.
 * Kept free of server-only imports so the Ask UI can reuse the detector.
 */
export function sanitizeAskErrorMessage(message: string, fallback: string): string {
  if (!message || looksLikeRawDatabaseError(message) || message.length > 180) {
    return fallback;
  }
  return message;
}
