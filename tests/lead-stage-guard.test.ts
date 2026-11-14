import { describe, expect, it } from "vitest";
import {
  aiMayMoveStage,
  aiMaySetQualification,
  markHumanLeadChange,
  type StageLike,
} from "@/services/lead-stage-guard";

const stage = (slug: string, position: number, extra: Partial<StageLike> = {}): StageLike => ({
  id: `stage_${slug}`,
  slug,
  position,
  ...extra,
});

const NEW = stage("new", 0);
const ENGAGED = stage("engaged", 2);
const QUALIFYING = stage("qualifying", 3);
const QUALIFIED = stage("qualified", 4);
const BOOKED = stage("booked", 6);
const WON = stage("won", 7, { isWon: true });
const DISQUALIFIED = stage("disqualified", 8, { isLost: true });

describe("lead stage guard — AI vs human pipeline decisions", () => {
  it("lets the AI move a lead forward through the pipeline", () => {
    expect(aiMayMoveStage({ current: NEW, target: ENGAGED, metadata: {} })).toBe(true);
    expect(aiMayMoveStage({ current: ENGAGED, target: QUALIFIED, metadata: {} })).toBe(true);
    expect(aiMayMoveStage({ current: null, target: ENGAGED, metadata: null })).toBe(true);
  });

  it("never drags a lead backwards (Booked → Engaged after 'thanks')", () => {
    expect(aiMayMoveStage({ current: QUALIFIED, target: ENGAGED, metadata: {} })).toBe(false);
    expect(aiMayMoveStage({ current: QUALIFIED, target: QUALIFYING, metadata: {} })).toBe(false);
  });

  it("never moves a lead out of Booked or Won", () => {
    expect(aiMayMoveStage({ current: BOOKED, target: DISQUALIFIED, metadata: {} })).toBe(false);
    expect(aiMayMoveStage({ current: WON, target: DISQUALIFIED, metadata: {} })).toBe(false);
  });

  it("respects a stage a person set by hand", () => {
    const meta = markHumanLeadChange({ crmMemory: { a: 1 } }, { stage: true, userId: "u1" });
    expect(meta.crmMemory).toEqual({ a: 1 });
    expect(meta.stageChangedBy).toBe("HUMAN");
    expect(aiMayMoveStage({ current: ENGAGED, target: QUALIFIED, metadata: meta })).toBe(false);
  });

  it("re-engages a lead the AI itself disqualified, but not one a person disqualified", () => {
    expect(
      aiMayMoveStage({ current: DISQUALIFIED, target: ENGAGED, metadata: { stageChangedBy: "AI" } }),
    ).toBe(true);
    const human = markHumanLeadChange({}, { stage: true });
    expect(aiMayMoveStage({ current: DISQUALIFIED, target: ENGAGED, metadata: human })).toBe(false);
  });

  it("does not overwrite qualification a person set", () => {
    expect(aiMaySetQualification({})).toBe(true);
    expect(aiMaySetQualification(markHumanLeadChange({}, { qualification: true }))).toBe(false);
  });
});
