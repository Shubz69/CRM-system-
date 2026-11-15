/**
 * Tiny in-memory stand-in for the Prisma client, covering the CRM tables the pipeline,
 * stage-editor and activity-timeline routes touch. It evaluates `where` filters (AND / OR /
 * NOT, in / notIn / lt / lte / gt / gte / equals / not, relation filters), orderBy, take,
 * select / include (one level of relations) — enough to test scoping, ordering and paging
 * against real rows instead of hand-fed mock return values.
 */
import { vi } from "vitest";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const RELATIONS: Record<string, Record<string, { table: string; fk: string }>> = {
  pipelineStage: { pipeline: { table: "pipeline", fk: "pipelineId" } },
  lead: {
    contact: { table: "contact", fk: "contactId" },
    stage: { table: "pipelineStage", fk: "stageId" },
  },
  crmActivity: {
    lead: { table: "lead", fk: "leadId" },
    deal: { table: "deal", fk: "dealId" },
    contact: { table: "contact", fk: "contactId" },
  },
  deal: { lead: { table: "lead", fk: "leadId" }, contact: { table: "contact", fk: "contactId" } },
  note: { contact: { table: "contact", fk: "contactId" } },
  booking: { contact: { table: "contact", fk: "contactId" } },
};

/** One-to-many relations: parent.key → rows of `table` whose `fk` is the parent's id. */
const HAS_MANY: Record<string, Record<string, { table: string; fk: string }>> = {
  pipeline: { stages: { table: "pipelineStage", fk: "pipelineId" } },
  pipelineStage: { leads: { table: "lead", fk: "stageId" } },
};

const TABLES = [
  "pipeline",
  "pipelineStage",
  "lead",
  "contact",
  "deal",
  "crmActivity",
  "note",
  "booking",
  "user",
] as const;
type Table = (typeof TABLES)[number];

const DEFAULTS: Partial<Record<Table, () => Row>> = {
  pipelineStage: () => ({ color: "#64748b", isWon: false, isLost: false }),
  crmActivity: () => ({
    contactId: null,
    leadId: null,
    dealId: null,
    companyId: null,
    body: null,
    dueAt: null,
    completedAt: null,
    createdByUserId: null,
    metadata: {},
  }),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function equal(a: unknown, b: unknown): boolean {
  return comparable(a) === comparable(b);
}

function compare(a: unknown, b: unknown): number {
  const x = comparable(a) as number | string;
  const y = comparable(b) as number | string;
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return x < y ? -1 : 1;
}

export function createFakeCrmDb() {
  const tables = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<Table, Row[]>;
  let seq = 0;

  function related(table: string, row: Row, key: string): Row | null | undefined {
    const rel = RELATIONS[table]?.[key];
    if (!rel) return undefined;
    return tables[rel.table as Table].find((r) => r.id === row[rel.fk]) ?? null;
  }

  function matchValue(value: unknown, cond: unknown): boolean {
    if (!isPlainObject(cond)) return equal(value, cond);
    for (const [op, arg] of Object.entries(cond)) {
      switch (op) {
        case "in":
          if (!(arg as unknown[]).some((a) => equal(value, a))) return false;
          break;
        case "notIn":
          if ((arg as unknown[]).some((a) => equal(value, a))) return false;
          break;
        case "equals":
          if (!equal(value, arg)) return false;
          break;
        case "not":
          if (isPlainObject(arg) ? matchValue(value, arg) : equal(value, arg)) return false;
          break;
        case "lt":
          if (value === null || value === undefined || compare(value, arg) >= 0) return false;
          break;
        case "lte":
          if (value === null || value === undefined || compare(value, arg) > 0) return false;
          break;
        case "gt":
          if (value === null || value === undefined || compare(value, arg) <= 0) return false;
          break;
        case "gte":
          if (value === null || value === undefined || compare(value, arg) < 0) return false;
          break;
        default:
          throw new Error(`fake db: unsupported operator ${op}`);
      }
    }
    return true;
  }

  function matches(table: string, row: Row, where: Where | undefined): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === undefined) continue;
      if (key === "AND") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w) => matches(table, row, w as Where))) return false;
        continue;
      }
      if (key === "OR") {
        if (!(cond as Where[]).some((w) => matches(table, row, w))) return false;
        continue;
      }
      if (key === "NOT") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((w) => matches(table, row, w as Where))) return false;
        continue;
      }
      const rel = RELATIONS[table]?.[key];
      if (rel) {
        const target = related(table, row, key);
        if (!target || !matches(rel.table, target, cond as Where)) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  function project(table: string, row: Row, args: { select?: Row; include?: Row }): Row {
    const shape = args.select ?? args.include;
    if (!shape) return { ...row };
    const out: Row = args.include ? { ...row } : {};
    for (const [key, spec] of Object.entries(shape)) {
      if (!spec) continue;
      const many = HAS_MANY[table]?.[key];
      if (many) {
        const opts = (isPlainObject(spec) ? spec : {}) as {
          where?: Where;
          orderBy?: unknown;
          take?: number;
          select?: Row;
          include?: Row;
        };
        let children = tables[many.table as Table].filter(
          (r) => r[many.fk] === row.id && matches(many.table, r, opts.where),
        );
        children = sortRows(children, opts.orderBy);
        if (opts.take !== undefined) children = children.slice(0, opts.take);
        out[key] = children.map((c) => project(many.table, c, opts));
        continue;
      }
      const rel = RELATIONS[table]?.[key];
      if (rel) {
        const target = related(table, row, key);
        out[key] =
          target && isPlainObject(spec)
            ? project(rel.table, target, spec as { select?: Row; include?: Row })
            : (target ?? null);
      } else {
        out[key] = row[key];
      }
    }
    return out;
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
    return [...rows].sort((a, b) => {
      for (const key of keys) {
        const [field, dir] = Object.entries(key)[0]!;
        const c = compare(a[field], b[field]);
        if (c !== 0) return dir === "desc" ? -c : c;
      }
      return 0;
    });
  }

  function model(table: Table) {
    const findMany = vi.fn(
      async (args: { where?: Where; orderBy?: unknown; take?: number; select?: Row; include?: Row } = {}) => {
        let rows = tables[table].filter((r) => matches(table, r, args.where));
        rows = sortRows(rows, args.orderBy);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((r) => project(table, r, args));
      },
    );
    return {
      findMany,
      findFirst: vi.fn(async (args: Parameters<typeof findMany>[0] = {}) => {
        const rows = await findMany({ ...args, take: 1 });
        return rows[0] ?? null;
      }),
      findUnique: vi.fn(async (args: { where: Where; select?: Row; include?: Row }) => {
        const row = tables[table].find((r) => matches(table, r, args.where));
        return row ? project(table, row, args) : null;
      }),
      count: vi.fn(async (args: { where?: Where } = {}) =>
        tables[table].filter((r) => matches(table, r, args.where)).length,
      ),
      create: vi.fn(async (args: { data: Row; select?: Row; include?: Row }) => {
        seq += 1;
        const row: Row = {
          id: `${table}_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(DEFAULTS[table]?.() ?? {}),
          ...args.data,
        };
        tables[table].push(row);
        return project(table, row, args);
      }),
      createMany: vi.fn(async (args: { data: Row[] }) => {
        for (const data of args.data) {
          seq += 1;
          tables[table].push({
            id: `${table}_${seq}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...(DEFAULTS[table]?.() ?? {}),
            ...data,
          });
        }
        return { count: args.data.length };
      }),
      update: vi.fn(async (args: { where: Where; data: Row; select?: Row; include?: Row }) => {
        const row = tables[table].find((r) => matches(table, r, args.where));
        if (!row) throw new Error(`fake db: ${table} not found for update`);
        Object.assign(row, args.data, { updatedAt: new Date() });
        return project(table, row, args);
      }),
      updateMany: vi.fn(async (args: { where?: Where; data: Row }) => {
        const rows = tables[table].filter((r) => matches(table, r, args.where));
        for (const row of rows) Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: rows.length };
      }),
      delete: vi.fn(async (args: { where: Where }) => {
        const index = tables[table].findIndex((r) => matches(table, r, args.where));
        if (index < 0) throw new Error(`fake db: ${table} not found for delete`);
        const [row] = tables[table].splice(index, 1);
        // Lead.stageId is ON DELETE SET NULL.
        if (table === "pipelineStage") {
          for (const lead of tables.lead) if (lead.stageId === row!.id) lead.stageId = null;
        }
        return row;
      }),
    };
  }

  const prisma = {
    pipeline: model("pipeline"),
    pipelineStage: model("pipelineStage"),
    lead: model("lead"),
    contact: model("contact"),
    deal: model("deal"),
    crmActivity: model("crmActivity"),
    note: model("note"),
    booking: model("booking"),
    user: model("user"),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (arg: unknown): Promise<unknown> => {
      if (typeof arg === "function") return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };

  function reset() {
    for (const t of TABLES) tables[t].length = 0;
    seq = 0;
    vi.clearAllMocks();
  }

  function seed(table: Table, rows: Row[]) {
    for (const row of rows) {
      tables[table].push({
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...(DEFAULTS[table]?.() ?? {}),
        ...row,
      });
    }
  }

  return { prisma, tables, reset, seed };
}

export const fakeDb = createFakeCrmDb();
