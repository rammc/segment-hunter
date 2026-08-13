import { describe, expect, it } from "vitest";
import {
  buildPowerCurve,
  curveSupports,
  displayCurve,
  estimatedFromSec,
  speedSupports,
} from "./scoring";
import type { CurvePoint, TaggedPoint, TaggedRunEffort } from "./types";

const ACT = { id: 42, name: "Feierabendrunde", date: "2026-08-01" };
const ACT2 = { id: 43, name: "Intervalle", date: "2026-08-05" };

/** Konstanter Watt-Stream einer gegebenen Laenge */
function stream(watts: number, seconds: number, activity = ACT) {
  const time = Array.from({ length: seconds + 1 }, (_, i) => i);
  return { time, watts: time.map(() => watts), activity };
}

describe("displayCurve", () => {
  it("kollabiert horizontale Plateaus auf ihre Eckpunkte", () => {
    // Envelope-typisch: viele geklemmte Punkte auf identischem Niveau
    const plateau: CurvePoint[] = [
      [5, 400],
      [60, 300],
      ...Array.from({ length: 50 }, (_, i) => [120 + i * 10, 250] as CurvePoint),
      [3600, 200],
    ];
    const thin = displayCurve(plateau);
    expect(thin.length).toBeLessThan(8);
    // Erster und letzter Punkt bleiben immer erhalten
    expect(thin[0]).toEqual([5, 400]);
    expect(thin[thin.length - 1]).toEqual([3600, 200]);
  });

  it("behaelt echte Eckpunkte", () => {
    const corners: CurvePoint[] = [
      [5, 500],
      [60, 350],
      [300, 280],
      [3600, 210],
    ];
    expect(displayCurve(corners)).toEqual(corners);
  });

  it("laesst kurze Kurven unangetastet", () => {
    const two: CurvePoint[] = [
      [5, 500],
      [3600, 210],
    ];
    expect(displayCurve(two)).toEqual(two);
  });
});

describe("curveSupports", () => {
  it("liefert pro Dauer den besten Wert samt Herkunfts-Aktivitaet", () => {
    const supports = curveSupports([stream(250, 700, ACT), stream(220, 700, ACT2)], [], null, [
      60, 300,
    ]);
    expect(supports).toHaveLength(2);
    expect(supports[0]).toMatchObject({ sec: 60, value: 250, kind: "stream", activity: ACT });
  });

  it("nutzt Efforts als Untergrenze fuer kuerzere Dauern", () => {
    // Effort ueber 10 min mit 300 W schlaegt den 250-W-Stream auch bei 60 s
    const efforts: TaggedPoint[] = [{ sec: 600, value: 300, activity: ACT2 }];
    const supports = curveSupports([stream(250, 700, ACT)], efforts, null, [60, 600]);
    expect(supports[0]).toMatchObject({ sec: 60, value: 300, kind: "effort", activity: ACT2 });
    expect(supports[1]).toMatchObject({ sec: 600, value: 300, kind: "effort" });
  });

  it("zieht FTP-Anker heran, wenn Streams und Efforts schwaecher sind", () => {
    const supports = curveSupports([stream(150, 700, ACT)], [], 260, [600]);
    // FTP-Anker: 20 min = 260 / 0.95 = 274 W, gilt als Untergrenze auch bei 10 min
    expect(supports[0].kind).toBe("ftp");
    expect(supports[0].value).toBe(Math.round(260 / 0.95));
    expect(supports[0].activity).toBeNull();
  });

  it("stimmt mit der Envelope von buildPowerCurve ueberein", () => {
    const streams = [stream(250, 700, ACT)];
    const efforts: TaggedPoint[] = [{ sec: 400, value: 280, activity: ACT2 }];
    const curve = buildPowerCurve(
      streams,
      efforts.map((e) => [e.sec, e.value] as CurvePoint)
    );
    const supports = curveSupports(streams, efforts, null, [60, 300]);
    for (const s of supports) {
      const onCurve = curve.find(([sec]) => sec === s.sec);
      expect(onCurve?.[1]).toBe(s.value);
    }
  });
});

describe("speedSupports", () => {
  const efforts: TaggedRunEffort[] = [
    { distance: 1000, moving_time: 240, activity: ACT }, // 4:00/km
    { distance: 5000, moving_time: 1500, activity: ACT2 }, // 5:00/km
  ];

  it("liefert pro Dauer den schnellsten echten Effort", () => {
    const supports = speedSupports(efforts, [120, 1200]);
    expect(supports[0]).toMatchObject({ sec: 120, kind: "effort", activity: ACT });
    expect(supports[0].value).toBeCloseTo(1000 / 240);
    expect(supports[1].activity).toEqual(ACT2);
  });

  it("ignoriert unplausible Efforts", () => {
    const supports = speedSupports([{ distance: 100, moving_time: 10, activity: ACT }], [5]);
    expect(supports).toHaveLength(0);
  });
});

describe("estimatedFromSec", () => {
  it("Rad: erste Dauer ohne Stream-Deckung", () => {
    const supports = [
      { sec: 60, value: 300, kind: "stream" as const, activity: ACT },
      { sec: 1200, value: 270, kind: "ftp" as const, activity: null },
    ];
    expect(estimatedFromSec([], supports, "ride")).toBe(1200);
  });

  it("Rad: null, wenn alles gemessen ist", () => {
    const supports = [{ sec: 60, value: 300, kind: "stream" as const, activity: ACT }];
    expect(estimatedFromSec([], supports, "ride")).toBeNull();
  });

  it("Laufen: erste Dauer, auf der die Kurve ueber den echten Efforts liegt", () => {
    const curve: CurvePoint[] = [
      [120, 4.2],
      [3600, 3.9], // Riegel hebt das lange Ende an
    ];
    const supports = [
      { sec: 120, value: 4.2, kind: "effort" as const, activity: ACT },
      { sec: 3600, value: 3.3, kind: "effort" as const, activity: ACT2 },
    ];
    expect(estimatedFromSec(curve, supports, "run")).toBe(3600);
  });
});
