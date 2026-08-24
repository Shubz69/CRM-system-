/**
 * Phase 14 — Connector capability identifiers (controlled).
 */

export const CONNECTOR_CAPABILITIES = [
  "READ_PROFILE",
  "READ_OWN_CONTENT",
  "READ_PUBLIC_CONTENT",
  "READ_COMMENTS",
  "READ_MESSAGES",
  "READ_ANALYTICS",
  "READ_ADS",
  "READ_CONTACTS",
  "READ_COMPANIES",
  "READ_DEALS",
  "READ_EMAIL",
  "READ_CALENDAR",
  "SEARCH",
  "PUBLISH",
  "SCHEDULE",
  "REPLY",
  "SEND_MESSAGE",
  "SEND_EMAIL",
  "CREATE_EVENT",
  "UPDATE_RECORD",
  "DELETE_RECORD",
  "WEBHOOK_RECEIVE",
  "WEBHOOK_SUBSCRIBE",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CONNECTOR_CATEGORIES = [
  "SOCIAL",
  "CRM",
  "MESSAGING",
  "EMAIL",
  "CALENDAR",
  "ANALYTICS",
  "ADS",
  "COMMERCE",
  "STORAGE",
  "COLLABORATION",
  "BOOKING",
  "RESEARCH",
  "CUSTOM_API",
  "AI",
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export type AuthMode = "oauth2" | "api_key" | "webhook_secret" | "env" | "none";

export type DataClassification = "PUBLIC" | "INTERNAL" | "CUSTOMER_DATA" | "PII" | "SECRET";

export type SideEffectClass =
  | "none"
  | "read"
  | "write_internal"
  | "outbound"
  | "publish"
  | "destructive";

export type ReconciliationSupport = "idempotency_key" | "lookup" | "neither";

export type ConnectorOperationDefinition = {
  name: string;
  capability: ConnectorCapability;
  risk: "read" | "write_internal" | "outbound_message" | "publish" | "destructive" | "admin";
  approvalRequired: boolean;
  idempotencySupport: boolean;
  providerIdempotency: ReconciliationSupport;
  timeoutMs: number;
  retryPolicy: "none" | "transient" | "bounded";
  rateLimitClass: string;
  costClass: "free" | "cheap" | "metered" | "expensive";
  piiClass: DataClassification;
  sideEffect: SideEffectClass;
  requiredScopes?: string[];
};

export type ConnectorDefinition = {
  providerKey: string;
  displayName: string;
  category: ConnectorCategory;
  version: string;
  authModes: AuthMode[];
  capabilities: ConnectorCapability[];
  requiredScopes: string[];
  apiVersion?: string;
  documentationUrl?: string;
  /** YYYY-MM-DD when docs were last verified by engineers. */
  docsVerifiedAt?: string;
  commercialRestrictions?: string[];
  webhookSupport: boolean;
  rateLimitNotes?: string;
  operations: ConnectorOperationDefinition[];
};

export type CustomerHealthLabel =
  | "Healthy"
  | "Attention required"
  | "Reconnect"
  | "Limited"
  | "Unavailable";
