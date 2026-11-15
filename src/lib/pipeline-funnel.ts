/**
 * Built-in funnel stages in the order the AI's "never move a lead backwards" rule assumes
 * (services/lead-stage-guard.ts compares stage positions). Their relative order is fixed;
 * custom stages and disqualified / lost / attended / no_show may sit anywhere.
 *
 * Pure (no server imports) so the stage editor can disable moves the API would refuse.
 */
export const FUNNEL_STAGE_SLUGS = [
  "new",
  "contacted",
  "engaged",
  "qualifying",
  "qualified",
  "booking_offered",
  "booked",
  "won",
] as const;

const FUNNEL_RANK = new Map<string, number>(FUNNEL_STAGE_SLUGS.map((slug, index) => [slug, index]));

/**
 * The first pair of funnel stages that `next` puts out of order although `current` had them
 * in order, as [earlier, later] (later now sits above earlier) — or null when the new order
 * keeps every funnel pair that was in order. An order that was already broken can be fixed.
 */
export function brokenFunnelPair(current: string[], next: string[]): [string, string] | null {
  const currentIndex = new Map(current.map((slug, index) => [slug, index]));
  const funnel = next
    .map((slug, index) => ({ slug, index, rank: FUNNEL_RANK.get(slug) }))
    .filter((s): s is { slug: string; index: number; rank: number } => s.rank !== undefined);
  for (const later of funnel) {
    for (const earlier of funnel) {
      if (earlier.rank >= later.rank || earlier.index < later.index) continue;
      const wasInOrder =
        (currentIndex.get(earlier.slug) ?? -1) < (currentIndex.get(later.slug) ?? Number.MAX_SAFE_INTEGER);
      if (wasInOrder) return [earlier.slug, later.slug];
    }
  }
  return null;
}
