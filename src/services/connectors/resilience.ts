/**
 * Rate-limit + circuit breaker for connectors (Postgres-backed).
 */

import { CircuitState } from "@prisma/client";
import { prisma } from "@/lib/db";

const FAILURE_THRESHOLD = Number(process.env.CONNECTOR_CIRCUIT_FAILURES || 5);
const OPEN_MS = Number(process.env.CONNECTOR_CIRCUIT_OPEN_MS || 5 * 60_000);

export async function recordProvider429(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  operationClass?: string;
  retryAfterSeconds?: number;
}) {
  const operationClass = input.operationClass ?? "default";
  const connectionRef = input.connectionRef ?? "env";
  const backoffUntil = new Date(
    Date.now() + (input.retryAfterSeconds ?? 60) * 1000,
  );
  await prisma.connectorRateLimitState.upsert({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        operationClass,
      },
    },
    create: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef,
      operationClass,
      backoffUntil,
      last429At: new Date(),
    },
    update: {
      backoffUntil,
      last429At: new Date(),
    },
  });
}

export async function assertNotRateLimited(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  operationClass?: string;
}): Promise<void> {
  const row = await prisma.connectorRateLimitState.findUnique({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef: input.connectionRef ?? "env",
        operationClass: input.operationClass ?? "default",
      },
    },
  });
  if (row?.backoffUntil && row.backoffUntil > new Date()) {
    throw new Error(
      `Provider rate-limited until ${row.backoffUntil.toISOString()}`,
    );
  }
}

export async function assertCircuitClosed(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  operationClass?: string;
}): Promise<void> {
  const connectionRef = input.connectionRef ?? "env";
  const operationClass = input.operationClass ?? "default";
  const row = await prisma.connectorCircuitState.findUnique({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        operationClass,
      },
    },
  });
  if (!row) return;
  if (row.state === CircuitState.OPEN) {
    const opened = row.openedAt?.getTime() ?? 0;
    if (Date.now() - opened < OPEN_MS) {
      throw new Error(`Provider circuit OPEN for ${input.providerKey}`);
    }
    await prisma.connectorCircuitState.update({
      where: { id: row.id },
      data: { state: CircuitState.HALF_OPEN, halfOpenAt: new Date() },
    });
  }
}

export async function recordCircuitSuccess(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  operationClass?: string;
}) {
  const connectionRef = input.connectionRef ?? "env";
  const operationClass = input.operationClass ?? "default";
  await prisma.connectorCircuitState.upsert({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        operationClass,
      },
    },
    create: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef,
      operationClass,
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastSuccessAt: new Date(),
    },
    update: {
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastSuccessAt: new Date(),
      openedAt: null,
      halfOpenAt: null,
      lastErrorSummary: null,
    },
  });
}

export async function recordCircuitFailure(input: {
  organisationId: string;
  providerKey: string;
  connectionRef?: string | null;
  operationClass?: string;
  errorSummary: string;
}) {
  const connectionRef = input.connectionRef ?? "env";
  const operationClass = input.operationClass ?? "default";
  const existing = await prisma.connectorCircuitState.findUnique({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        operationClass,
      },
    },
  });
  const failureCount = (existing?.failureCount ?? 0) + 1;
  const open = failureCount >= FAILURE_THRESHOLD;
  await prisma.connectorCircuitState.upsert({
    where: {
      organisationId_providerKey_connectionRef_operationClass: {
        organisationId: input.organisationId,
        providerKey: input.providerKey,
        connectionRef,
        operationClass,
      },
    },
    create: {
      organisationId: input.organisationId,
      providerKey: input.providerKey,
      connectionRef,
      operationClass,
      state: open ? CircuitState.OPEN : CircuitState.CLOSED,
      failureCount,
      openedAt: open ? new Date() : null,
      lastFailureAt: new Date(),
      lastErrorSummary: input.errorSummary.slice(0, 2000),
    },
    update: {
      failureCount,
      state: open ? CircuitState.OPEN : existing?.state === CircuitState.HALF_OPEN ? CircuitState.OPEN : CircuitState.CLOSED,
      openedAt: open ? new Date() : existing?.openedAt,
      lastFailureAt: new Date(),
      lastErrorSummary: input.errorSummary.slice(0, 2000),
    },
  });
}
