/**
 * Explicit runtime modes — production must never silently fall back to mocks.
 */
export type RuntimeMode = "development" | "test" | "production";

export function getRuntimeMode(): RuntimeMode {
  const explicit = (process.env.APP_RUNTIME_MODE || "").toLowerCase();
  if (explicit === "development" || explicit === "test" || explicit === "production") {
    return explicit;
  }
  // Vitest / unit tests (host may still have NODE_ENV=production)
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return "test";
  }
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

export function isProductionRuntime(): boolean {
  return getRuntimeMode() === "production";
}

/**
 * Mock transports are allowed in development/test.
 * In production they are never used silently — only when DEMO_MODE is explicitly enabled
 * (demo / preview environments that intentionally use simulators).
 */
export function allowMockTransports(): boolean {
  const mode = getRuntimeMode();
  if (mode === "test" || mode === "development") return true;
  if (process.env.DEMO_MODE === "true") return true;
  return false;
}
