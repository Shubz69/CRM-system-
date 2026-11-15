/**
 * Business profile: adding a second market appends it (the first is no longer marked STALE),
 * re-adding a market re-verifies it, and adding an existing audience name doesn't duplicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimFindFirst: vi.fn(),
  claimCreate: vi.fn(),
  claimUpdate: vi.fn(),
  audienceFindFirst: vi.fn(),
  audienceCreate: vi.fn(),
  audienceUpdate: vi.fn(),
  productFindFirst: vi.fn(),
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    businessClaim: {
      findFirst: (...args: unknown[]) => mocks.claimFindFirst(...args),
      create: (...args: unknown[]) => mocks.claimCreate(...args),
      update: (...args: unknown[]) => mocks.claimUpdate(...args),
    },
    audienceSegment: {
      findFirst: (...args: unknown[]) => mocks.audienceFindFirst(...args),
      create: (...args: unknown[]) => mocks.audienceCreate(...args),
      update: (...args: unknown[]) => mocks.audienceUpdate(...args),
    },
    productOffering: {
      findFirst: (...args: unknown[]) => mocks.productFindFirst(...args),
      create: (...args: unknown[]) => mocks.productCreate(...args),
      update: (...args: unknown[]) => mocks.productUpdate(...args),
    },
  },
}));

import {
  createAudienceSegment,
  createProductOffering,
  upsertBusinessClaim,
} from "@/services/digital-twin";

const market = (valueText: string) => ({
  organisationId: "org_a",
  subjectType: "Organisation",
  subjectId: "org_a",
  predicate: "operates_in_market",
  valueText,
  source: "business_profile_checklist",
});

describe("digital twin append semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
    mocks.claimUpdate.mockImplementation(async ({ data }: { data: unknown }) => data);
  });

  it("adds a second market without marking the first STALE", async () => {
    // No live claim with this value (the "UK" claim exists but doesn't match "US East Coast").
    mocks.claimFindFirst.mockResolvedValue(null);
    await upsertBusinessClaim(market("US East Coast"));
    expect(mocks.claimFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          predicate: "operates_in_market",
          valueText: { equals: "US East Coast", mode: "insensitive" },
        }),
      }),
    );
    expect(mocks.claimUpdate).not.toHaveBeenCalled();
    expect(mocks.claimCreate).toHaveBeenCalledTimes(1);
    expect(mocks.claimCreate.mock.calls[0]![0].data).toMatchObject({
      predicate: "operates_in_market",
      valueText: "US East Coast",
      status: "OBSERVED",
    });
  });

  it("re-adding an existing market re-verifies it instead of duplicating", async () => {
    mocks.claimFindFirst.mockResolvedValue({ id: "c_uk", confidence: 0.5, evidenceReference: null });
    await upsertBusinessClaim(market("uk"));
    expect(mocks.claimCreate).not.toHaveBeenCalled();
    expect(mocks.claimUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.claimUpdate.mock.calls[0]![0].where).toEqual({ id: "c_uk" });
    expect(mocks.claimUpdate.mock.calls[0]![0].data).not.toHaveProperty("status");
  });

  it("single-valued predicates still supersede the previous value", async () => {
    mocks.claimFindFirst.mockResolvedValue({ id: "c_old", valueText: "Old name" });
    await upsertBusinessClaim({ ...market("New name"), predicate: "business_name" });
    expect(mocks.claimUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c_old" }, data: expect.objectContaining({ status: "STALE" }) }),
    );
    expect(mocks.claimCreate).toHaveBeenCalledTimes(1);
  });

  it("adding an audience appends; an existing name (any case) is returned, not duplicated", async () => {
    mocks.audienceFindFirst.mockResolvedValueOnce(null);
    mocks.audienceCreate.mockResolvedValue({ id: "a2", name: "Salon owners" });
    await createAudienceSegment({ organisationId: "org_a", name: " Salon owners " });
    expect(mocks.audienceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Salon owners" }) }),
    );

    mocks.audienceFindFirst.mockResolvedValueOnce({ id: "a2", name: "Salon owners", description: null });
    const again = await createAudienceSegment({ organisationId: "org_a", name: "salon OWNERS" });
    expect(again).toMatchObject({ id: "a2" });
    expect(mocks.audienceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.audienceFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { organisationId: "org_a", name: { equals: "salon OWNERS", mode: "insensitive" } },
      }),
    );
  });
});

describe("products don't duplicate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adding a product that exists in another case returns the existing one", async () => {
    const existing = { id: "p1", name: "Balayage colour", status: "ACTIVE" };
    mocks.productFindFirst.mockResolvedValueOnce(existing);

    const result = await createProductOffering({ organisationId: "org_a", name: "  balayage COLOUR " });

    expect(result).toBe(existing);
    expect(mocks.productCreate).not.toHaveBeenCalled();
    expect(mocks.productFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organisationId: "org_a",
          name: { equals: "balayage COLOUR", mode: "insensitive" },
          status: { not: "ARCHIVED" },
        },
      }),
    );
  });

  it("a new product is created with a trimmed name", async () => {
    mocks.productFindFirst.mockResolvedValueOnce(null);
    mocks.productCreate.mockImplementation(async ({ data }: { data: unknown }) => data);

    await createProductOffering({ organisationId: "org_a", name: " Gloss treatment " });

    expect(mocks.productCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Gloss treatment", currency: "GBP" }),
    });
  });
});
