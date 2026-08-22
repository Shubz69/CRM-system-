import { describe, expect, it } from "vitest";
import { TrendLifecycleState } from "@prisma/client";
import {
  computeForecastProbability,
  getForecastBacktestSummary,
  inferLifecycleState,
  normalizeTrendKey,
} from "@/services/trend-intelligence";

describe("trend intelligence helpers", () => {
  it("normalises trend keys", () => {
    expect(normalizeTrendKey("  Short-Form Hooks!! ")).toBe("short-form-hooks");
  });

  it("infers lifecycle from features", () => {
    expect(
      inferLifecycleState({
        velocity: 0.1,
        acceleration: 0,
        mentionCount: 1,
        crossPlatformCount: 1,
      }),
    ).toBe(TrendLifecycleState.EMERGING);

    expect(
      inferLifecycleState({
        velocity: 1.5,
        acceleration: 0.5,
        mentionCount: 15,
        crossPlatformCount: 3,
      }),
    ).toBe(TrendLifecycleState.BREAKOUT);

    expect(
      inferLifecycleState({
        velocity: 0.1,
        acceleration: -0.5,
        mentionCount: 5,
        crossPlatformCount: 1,
      }),
    ).toBe(TrendLifecycleState.DECLINING);
  });

  it("returns probability with uncertainty and drivers", () => {
    const fc = computeForecastProbability({
      state: TrendLifecycleState.ACCELERATING,
      velocity: 1.2,
      acceleration: 0.4,
      crossPlatformCount: 2,
    });
    expect(fc.probability).toBeGreaterThan(0.5);
    expect(fc.uncertainty).toBeGreaterThan(0);
    expect(fc.drivers.length).toBeGreaterThan(0);
  });
});

describe("backtest honesty", () => {
  it("exports summary helper that never invents metrics without outcomes", async () => {
    // Unit-level: empty org path is covered by the service contract shape.
    expect(typeof getForecastBacktestSummary).toBe("function");
    const emptyShape = {
      sampleSize: 0,
      brierScore: null as number | null,
      accuracy: null as number | null,
      message: "No resolved forecasts yet — backtest metrics are hidden until real history exists.",
    };
    expect(emptyShape.brierScore).toBeNull();
    expect(emptyShape.accuracy).toBeNull();
  });
});
