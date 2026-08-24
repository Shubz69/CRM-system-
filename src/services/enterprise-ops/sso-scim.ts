/**
 * Phase 18 — SSO / SCIM readiness stubs.
 * Labelled FOUNDATION only — do not fake IdP / SCIM providers.
 */

export const SSO_SCIM_MATURITY = "FOUNDATION" as const;

export type SsoProviderStub = {
  id: string;
  displayName: string;
  protocol: "SAML" | "OIDC";
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
};

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
      "MFA belongs with IdP / auth provider — not simulated here (FOUNDATION).",
    liveProvidersConfigured: false,
    message:
      "SSO/SCIM readiness stubs only (FOUNDATION). No fake providers or successful auth claims.",
  };
}

/** Always false — stubs never claim connectivity. */
export function isSsoLive(_providerId: string): false {
  return false;
}

export function isScimLive(_directoryId: string): false {
  return false;
}
