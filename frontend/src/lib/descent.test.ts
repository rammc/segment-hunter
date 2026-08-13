import { describe, expect, it } from "vitest";
import { huntScore, isDescent, komFeasibility } from "./scoring";
import type { CurvePoint } from "./types";

const curve: CurvePoint[] = [
  [5, 620],
  [60, 450],
  [300, 320],
  [3600, 250],
];

/* Abfahrts-Segment wie "Teufelsberg (only descend)": 35 W gerollt, KOM 40 s */
const descent = {
  komTime: 40,
  time: 59,
  watts: 35,
  dist: 640,
  elev: 40,
  avgGrade: -6.2,
  rank: null,
};

const climb = { ...descent, avgGrade: 6.2, watts: 280 };

describe("isDescent", () => {
  it("erkennt negatives Durchschnittsgefaelle", () => {
    expect(isDescent({ avgGrade: -6.2 })).toBe(true);
    expect(isDescent({ avgGrade: -0.5 })).toBe(false); // leicht abschuessig = noch flach
    expect(isDescent({ avgGrade: 3 })).toBe(false);
    expect(isDescent({ avgGrade: null })).toBe(false);
    expect(isDescent({})).toBe(false);
  });
});

describe("komFeasibility auf Abfahrten", () => {
  it("bewertet Abfahrten nicht (kein 'KOM in Reichweite' mit 53 W)", () => {
    expect(komFeasibility(descent, curve)).toBeNull();
  });

  it("meldet einen gehaltenen KOM auch auf der Abfahrt", () => {
    expect(komFeasibility({ ...descent, komTime: 59 }, curve)).toMatchObject({ status: "kom" });
  });

  it("bewertet Anstiege weiterhin", () => {
    expect(komFeasibility(climb, curve)).not.toBeNull();
  });
});

describe("huntScore auf Abfahrten", () => {
  it("gibt keine Watt-Reserve-Punkte fuer gerollte Abfahrten", () => {
    const down = huntScore(descent, curve);
    const up = huntScore(climb, curve);
    expect(down.headroom).toBe(0);
    // Nur der neutrale Rang-Bonus bleibt
    expect(down.score).toBeLessThanOrEqual(30);
    expect(up.score).toBeGreaterThan(down.score);
  });
});
