/**
 * Phase 18 — SSO / SCIM readiness contracts (FOUNDATION).
 * No fake IdP / SCIM providers. Policy may live as JSON (OrganisationPreference key).
 */

export const SSO_SCIM_MATURITY = "FOUNDATION" as const;

export const SSO_POLICY_PREFERENCE_KEY = "sso_policy" as const;

export type SsoProtocol = "SAML" | "OIDC";

export type OrganisationSsoPolicy = {
  enabled: boolean;
  protocol?: SsoProtocol | null;
  /** Require MFA at IdP — enforced by assertMfaPolicy when enabled. */
  requireMfa: boolean;
  allowedIdpEntityIds?: string[];
  scimProvisioningEnabled?: boolean;
  /** Free-form notes — never treat as live connectivity. */
  notes?: string;
};

export const DEFAULT_SSO_POLICY: OrganisationSsoPolicy = {
  enabled: false,
  protocol: null,
  requireMfa: true,
  allowedIdpEntityIds: [],
  scimProvisioningEnabled: false,
  notes: "FOUNDATION stub — IdP not connected.",
};

export type SsoProviderStub = {
  id: string;
  displayName: string;
  protocol: SsoProtocol;
  status: "not_configured";
  maturity: typeof SSO_SCIM_MATURITY;
  note: string;
};

export type ScimDirectoryStub = {
  id: string;
  displayName: string;
  status: "not_configured";
  maturity: typeof SSO_SCIM_MATURITY;
  note: string;
};

export type SsoScimReadiness = {
  maturity: typeof SSO_SCIM_MATURITY;
  sso: SsoProviderStub[];
  scim: ScimDirectoryStub[];
  mfaArchitectureNote: string;
  liveProvidersConfigured: false;
  message: string;
  policyContract: {
    preferenceKey: typeof SSO_POLICY_PREFERENCE_KEY;
    defaultPolicy: OrganisationSsoPolicy;
  };
};

export class MfaPolicyError extends Error {
  readonly code = "MFA_POLICY";
  constructor(message: string) {
    super(message);
    this.name = "MfaPolicyError";
  }
}

export function parseOrganisationSsoPolicy(raw: unknown): OrganisationSsoPolicy {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SSO_POLICY };
  }
  const o = raw as Record<string, unknown>;
  const protocol =
    o.protocol === "SAML" || o.protocol === "OIDC" ? o.protocol : null;
  return {
    enabled: o.enabled === true,
    protocol,
    requireMfa: o.requireMfa !== false,
    allowedIdpEntityIds: Array.isArray(o.allowedIdpEntityIds)
      ? o.allowedIdpEntityIds.map((x) => String(x))
      : [],
    scimProvisioningEnabled: o.scimProvisioningEnabled === true,
    notes: typeof o.notes === "string" ? o.notes : DEFAULT_SSO_POLICY.notes,
  };
}

/**
 * Assert MFA policy for a session/login attempt.
 * When SSO is enabled and requireMfa is true, mfaSatisfied must be true.
 * Does not talk to an IdP — contract only (FOUNDATION).
 */
export function assertMfaPolicy(input: {
  policy: OrganisationSsoPolicy | unknown;
  mfaSatisfied?: boolean;
}): OrganisationSsoPolicy {
  const policy = parseOrganisationSsoPolicy(input.policy);
  if (!policy.enabled) {
    return policy;
  }
  if (policy.requireMfa && input.mfaSatisfied !== true) {
    throw new MfaPolicyError(
      "MFA required by OrganisationSsoPolicy — IdP MFA assertion missing (FOUNDATION gate)",
    );
  }
  return policy;
}

/**
 * Readiness catalogue — no live SSO/SCIM connections invented.
 */
export function getSsoScimReadiness(): SsoScimReadiness {
  return {
    maturity: SSO_SCIM_MATURITY,
    sso: [
      {
        id: "sso_saml_stub",
        displayName: "Enterprise SAML (stub)",
        protocol: "SAML",
        status: "not_configured",
        maturity: SSO_SCIM_MATURITY,
        note: "FOUNDATION — adapter not implemented; do not treat as connected.",
      },
      {
        id: "sso_oidc_stub",
        displayName: "Enterprise OIDC (stub)",
        protocol: "OIDC",
        status: "not_configured",
        maturity: SSO_SCIM_MATURITY,
        note: "FOUNDATION — adapter not implemented; do not treat as connected.",
      },
    ],
    scim: [
      {
        id: "scim_v2_stub",
        displayName: "SCIM 2.0 directory sync (stub)",
        status: "not_configured",
        maturity: SSO_SCIM_MATURITY,
        note: "FOUNDATION — no provisioning calls; do not fake user sync.",
      },
    ],
    mfaArchitectureNote:
      "MFA belongs with IdP / auth provider — assertMfaPolicy enforces OrganisationSsoPolicy.requireMfa locally (FOUNDATION).",
    liveProvidersConfigured: false,
    message:
      "SSO/SCIM readiness stubs only (FOUNDATION). No fake providers or successful auth claims.",
    policyContract: {
      preferenceKey: SSO_POLICY_PREFERENCE_KEY,
      defaultPolicy: DEFAULT_SSO_POLICY,
    },
  };
}

/** Always false — stubs never claim connectivity. */
export function isSsoLive(_providerId: string): false {
  return false;
}

export function isScimLive(_directoryId: string): false {
  return false;
}
