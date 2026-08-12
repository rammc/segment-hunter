import { describe, expect, it } from "vitest";
import {
  buildPowerCurve,
  buildSpeedCurve,
  curveAt,
  fmtPace,
  fmtTime,
  ftpCurvePoints,
  huntScore,
  interpolateAt,
  komFeasibility,
  maxAvgPower,
  parseKomTime,
  physicsKomWatts,
  requiredWattsForKom,
  runFeasibility,
  runHuntScore,
} from "./scoring";
import type { CurvePoint } from "./types";

const CURVE: CurvePoint[] = [
  [5, 900],
  [60, 450],
  [300, 320],
  [1200, 260],
  [3600, 230],
];

describe("curveAt", () => {
  it("gibt null fuer eine leere Kurve", () => {
    expect(curveAt([], 60)).toBeNull();
  });

  it("klemmt an den Raendern", () => {
    expect(curveAt(CURVE, 1)).toBe(900);
    expect(curveAt(CURVE, 7200)).toBe(230);
  });

  it("trifft die Stuetzstellen exakt", () => {
    expect(curveAt(CURVE, 300)).toBe(320);
  });

  it("interpoliert logarithmisch zwischen Stuetzstellen", () => {
    // zwischen 60s (450 W) und 300s (320 W)
    const w = curveAt(CURVE, 120)!;
    expect(w).toBeLessThan(450);
    expect(w).toBeGreaterThan(320);
    // log-Interpolation: f = ln(120/60)/ln(300/60) ~ 0.4307
    const expected = Math.round(450 + 0.4307 * (320 - 450));
    expect(Math.abs(w - expected)).toBeLessThanOrEqual(1);
  });

  it("ist unabhaengig von der Sortierung der Eingabe", () => {
    const shuffled: CurvePoint[] = [[300, 320], [5, 900], [3600, 230], [60, 450], [1200, 260]];
    expect(curveAt(shuffled, 120)).toBe(curveAt(CURVE, 120));
  });
});

describe("parseKomTime", () => {
  it("parst m:ss", () => {
    expect(parseKomTime("5:31")).toBe(331);
  });
  it("parst h:mm:ss", () => {
    expect(parseKomTime("1:02:11")).toBe(3731);
  });
  it("parst Sekunden mit s-Suffix", () => {
    expect(parseKomTime("45s")).toBe(45);
  });
  it("gibt null fuer Unsinn und leere Werte", () => {
    expect(parseKomTime("abc")).toBeNull();
    expect(parseKomTime("")).toBeNull();
    expect(parseKomTime(null)).toBeNull();
    expect(parseKomTime(undefined)).toBeNull();
  });
});

describe("requiredWattsForKom", () => {
  const base = { watts: 250, time: 600, dist: 5000, elev: 50 }; // 1 % Steigung

  it("nutzt v^2.7 im Flachen", () => {
    // 10 % schneller noetig -> Faktor (600/540)^2.7
    const need = requiredWattsForKom(base, 540)!;
    expect(need).toBe(Math.round(250 * Math.pow(600 / 540, 2.7)));
  });

  it("nutzt P proportional v bei >= 5 % Steigung", () => {
    const steep = { watts: 250, time: 600, dist: 4000, elev: 240 }; // 6 %
    const need = requiredWattsForKom(steep, 540)!;
    expect(need).toBe(Math.round(250 * Math.pow(600 / 540, 1.05)));
  });

  it("blendet dazwischen linear", () => {
    const mid = { watts: 250, time: 600, dist: 5000, elev: 150 }; // 3 %
    const k = 2.7 - ((3 - 1) / 4) * (2.7 - 1.05);
    const need = requiredWattsForKom(mid, 540)!;
    expect(need).toBe(Math.round(250 * Math.pow(600 / 540, k)));
  });

  it("gibt null bei unplausiblen Watt oder wenn KOM nicht schneller ist", () => {
    expect(requiredWattsForKom({ ...base, watts: 20 }, 540)).toBeNull();
    expect(requiredWattsForKom(base, 600)).toBeNull();
    expect(requiredWattsForKom(base, null)).toBeNull();
  });
});

describe("huntScore", () => {
  it("deckelt die Reserve bei 60 % und liefert vollen Score", () => {
    // ref bei 300s = 320 W, eigene 100 W -> headroom weit ueber 0.6
    const { score, headroom } = huntScore({ time: 300, watts: 100, rank: null }, CURVE);
    expect(headroom).toBeGreaterThan(0.6);
    // 0.7 * 1 + 0.3 * 0.3 = 0.79
    expect(score).toBe(79);
  });

  it("nutzt den neutralen Rang-Bonus 0.3 ohne Rang", () => {
    const { score } = huntScore({ time: 300, watts: 320, rank: null }, CURVE);
    // keine Reserve, nur 0.3 * 0.3
    expect(score).toBe(9);
  });

  it("belohnt gute Raenge", () => {
    const better = huntScore({ time: 300, watts: 320, rank: 1 }, CURVE);
    const worse = huntScore({ time: 300, watts: 320, rank: 55 }, CURVE);
    expect(better.score).toBeGreaterThan(worse.score);
  });

  it("markiert unplausible Efforts als unzuverlaessig", () => {
    expect(huntScore({ time: 300, watts: 10, rank: null }, CURVE).reliable).toBe(false);
    expect(huntScore({ time: 20, watts: 200, rank: null }, CURVE).reliable).toBe(false);
    expect(huntScore({ time: 300, watts: 200, rank: null }, CURVE).reliable).toBe(true);
  });
});

describe("komFeasibility", () => {
  const seg = { time: 600, watts: 250, dist: 5000, elev: 50 };

  it("gibt null ohne KOM-Zeit", () => {
    expect(komFeasibility({ ...seg, komTime: null }, CURVE)).toBeNull();
    expect(komFeasibility({ ...seg, komTime: undefined }, CURVE)).toBeNull();
  });

  it("erkennt gehaltene KOMs", () => {
    const f = komFeasibility({ ...seg, komTime: 600 }, CURVE)!;
    expect(f.status).toBe("kom");
    expect(f.ratio).toBe(1);
  });

  it("stuft nach ratio in attack, train und far ein", () => {
    // KOM knapp schneller: benoetigte Watt kaum hoeher, Kurve gibt genug her
    const attack = komFeasibility({ ...seg, komTime: 595 }, CURVE)!;
    expect(attack.status).toBe("attack");
    expect(attack.ratio).toBeGreaterThanOrEqual(0.97);

    // KOM sehr viel schneller: weit ausser Reichweite
    const far = komFeasibility({ ...seg, komTime: 300 }, CURVE)!;
    expect(far.status).toBe("far");
    expect(far.ratio).toBeLessThan(0.85);
  });

  it("liefert need, have und gap", () => {
    const f = komFeasibility({ ...seg, komTime: 540 }, CURVE)!;
    expect(f.need).toBe(requiredWattsForKom(seg, 540));
    expect(f.have).toBe(curveAt(CURVE, 540));
    expect(f.gap).toBe(60);
  });
});

describe("fmtTime", () => {
  it("formatiert Sekunden, Minuten und Stunden", () => {
    expect(fmtTime(45)).toBe("45 s");
    expect(fmtTime(331)).toBe("5:31 min");
    expect(fmtTime(3731)).toBe("1:02:11");
  });
  it("gibt Platzhalter fuer null", () => {
    expect(fmtTime(null)).toBe("-");
  });
});

describe("maxAvgPower", () => {
  // 1-Hz-Stream: 60s bei 200 W, dann 30s bei 400 W, dann 60s bei 150 W
  const time: number[] = [];
  const watts: number[] = [];
  let t = 0;
  for (let i = 0; i < 60; i++) { time.push(t++); watts.push(200); }
  for (let i = 0; i < 30; i++) { time.push(t++); watts.push(400); }
  for (let i = 0; i < 60; i++) { time.push(t++); watts.push(150); }

  it("findet die beste 30s-Leistung", () => {
    expect(maxAvgPower(time, watts, 30)).toBe(400);
  });

  it("mittelt ueber laengere Fenster", () => {
    const w60 = maxAvgPower(time, watts, 60)!;
    expect(w60).toBeGreaterThan(250);
    expect(w60).toBeLessThan(400);
  });

  it("gibt null, wenn die Aktivitaet kuerzer als das Fenster ist", () => {
    expect(maxAvgPower(time, watts, 3600)).toBeNull();
  });

  it("wertet Aufzeichnungsluecken nicht als Fahrzeit", () => {
    // 30s bei 300 W, 10-Minuten-Luecke, 30s bei 300 W
    const gt: number[] = [];
    const gw: number[] = [];
    for (let i = 0; i < 30; i++) { gt.push(i); gw.push(300); }
    for (let i = 0; i < 30; i++) { gt.push(630 + i); gw.push(300); }
    // Die Luecke wird gedeckelt, die 60s-Bestleistung bleibt nahe 300 W
    const w = maxAvgPower(gt, gw, 30)!;
    expect(w).toBeGreaterThanOrEqual(290);
  });
});

describe("buildPowerCurve", () => {
  it("baut die Kurve aus einem Stream", () => {
    const time: number[] = [];
    const watts: number[] = [];
    for (let i = 0; i < 400; i++) { time.push(i); watts.push(i < 30 ? 500 : 250); }
    const curve = buildPowerCurve([{ time, watts }]);
    const at = new Map(curve);
    expect(at.get(5)).toBe(500);
    expect(at.get(300)).toBeGreaterThanOrEqual(250);
    expect(at.has(3600)).toBe(false); // Aktivitaet zu kurz
  });

  it("nimmt Effort-Punkte als Fallback auf", () => {
    const curve = buildPowerCurve([], [[240, 310], [900, 260]]);
    expect(curve).toEqual([[240, 310], [900, 260]]);
  });

  it("erzwingt Monotonie (kuerzer nie schwaecher als laenger)", () => {
    const curve = buildPowerCurve([], [[60, 200], [300, 350], [600, 240]]);
    for (let i = 0; i < curve.length - 1; i++) {
      expect(curve[i][1]).toBeGreaterThanOrEqual(curve[i + 1][1]);
    }
    expect(new Map(curve).get(60)).toBe(350);
  });

  it("ignoriert unplausible Punkte", () => {
    const curve = buildPowerCurve([], [[0, 300], [60, 0], [-5, 100], [120, NaN as unknown as number]]);
    expect(curve).toEqual([]);
  });
});

describe("ftpCurvePoints", () => {
  it("liefert Stuetzstellen bei 20 und 60 Minuten", () => {
    expect(ftpCurvePoints(250)).toEqual([
      [1200, Math.round(250 / 0.95)],
      [3600, 250],
    ]);
  });

  it("gibt nichts fuer fehlende oder unplausible FTP-Werte", () => {
    expect(ftpCurvePoints(null)).toEqual([]);
    expect(ftpCurvePoints(undefined)).toEqual([]);
    expect(ftpCurvePoints(0)).toEqual([]);
    expect(ftpCurvePoints(20)).toEqual([]);
    expect(ftpCurvePoints(900)).toEqual([]);
  });

  it("hebt die Kurve an, wenn die Fahrten locker waren", () => {
    // lockere Efforts weit unter FTP-Niveau
    const curve = buildPowerCurve([], [[300, 150], [1800, 120], ...ftpCurvePoints(250)]);
    const at = new Map(curve);
    expect(at.get(3600)).toBe(250);
    expect(at.get(1200)).toBe(Math.round(250 / 0.95));
    // Monotonie zieht auch kuerzere Dauern hoch
    expect(at.get(300)!).toBeGreaterThanOrEqual(Math.round(250 / 0.95));
  });

  it("ueberschreibt echte Bestwerte nicht nach unten", () => {
    // Fahrer hat bei 20 min mehr getreten, als das FTP vermuten laesst
    const curve = buildPowerCurve([], [[1200, 320], ...ftpCurvePoints(250)]);
    expect(new Map(curve).get(1200)).toBe(320);
  });
});

/* ---------- Laufen ---------- */

// Pace-Kurve: 400 m in 80 s (5 m/s), 1 km in 220 s (~4.55 m/s),
// 5 km in 1250 s (4 m/s), 10 km in 2700 s (~3.7 m/s)
const RUN_EFFORTS = [
  { distance: 400, moving_time: 80 },
  { distance: 1000, moving_time: 220 },
  { distance: 5000, moving_time: 1250 },
  { distance: 10000, moving_time: 2700 },
];

describe("buildSpeedCurve", () => {
  it("baut eine monoton fallende Geschwindigkeitskurve", () => {
    const curve = buildSpeedCurve(RUN_EFFORTS);
    expect(curve.length).toBe(4);
    for (let i = 0; i < curve.length - 1; i++) {
      expect(curve[i][1]).toBeGreaterThanOrEqual(curve[i + 1][1]);
    }
    expect(curve[0]).toEqual([80, 5]);
  });

  it("filtert zu kurze und zu langsame Datenpunkte", () => {
    const curve = buildSpeedCurve([
      { distance: 100, moving_time: 15 }, // zu kurz (Zeit und Distanz)
      { distance: 150, moving_time: 40 }, // Distanz unter Minimum
      { distance: 1000, moving_time: 240 },
    ]);
    expect(curve).toEqual([[240, 1000 / 240]]);
  });

  it("nimmt bei gleicher Dauer den schnelleren Punkt", () => {
    const curve = buildSpeedCurve([
      { distance: 1000, moving_time: 240 },
      { distance: 1100, moving_time: 240 },
    ]);
    expect(curve).toEqual([[240, 1100 / 240]]);
  });
});

describe("interpolateAt", () => {
  it("liefert unrundete Werte fuer Pace-Kurven", () => {
    const curve = buildSpeedCurve(RUN_EFFORTS);
    const v = interpolateAt(curve, 600)!;
    expect(v).toBeGreaterThan(4); // schneller als 5-km-Pace
    expect(v).toBeLessThan(1000 / 220); // langsamer als 1-km-Pace
    expect(Number.isInteger(v)).toBe(false);
  });
});

describe("runHuntScore", () => {
  const curve = buildSpeedCurve(RUN_EFFORTS);

  it("belohnt Reserve gegenueber der Pace-Kurve", () => {
    // Segment 1 km in 300 s (3.33 m/s), Kurve kann dort deutlich mehr
    const slow = runHuntScore({ time: 300, dist: 1000, rank: null }, curve);
    const fast = runHuntScore({ time: 220, dist: 1000, rank: null }, curve);
    expect(slow.score).toBeGreaterThan(fast.score);
  });

  it("markiert zu kurze Efforts als unzuverlaessig", () => {
    expect(runHuntScore({ time: 20, dist: 100, rank: null }, curve).reliable).toBe(false);
    expect(runHuntScore({ time: 300, dist: 1000, rank: null }, curve).reliable).toBe(true);
  });
});

describe("runFeasibility", () => {
  const curve = buildSpeedCurve(RUN_EFFORTS);

  it("erkennt gehaltene CRs", () => {
    const f = runFeasibility({ dist: 1000, time: 220, komTime: 220 }, curve)!;
    expect(f.status).toBe("kom");
  });

  it("vergleicht benoetigte mit verfuegbarer Geschwindigkeit", () => {
    // CR 1 km in 225 s: benoetigt ~4.44 m/s, Kurve kann dort ~4.5 m/s
    const f = runFeasibility({ dist: 1000, time: 300, komTime: 225 }, curve)!;
    expect(f.status).toBe("attack");
    expect(f.need).toBeCloseTo(1000 / 225, 3);
    expect(f.ratio).toBeGreaterThanOrEqual(0.97);

    // CR unrealistisch schnell
    const far = runFeasibility({ dist: 1000, time: 300, komTime: 150 }, curve)!;
    expect(far.status).toBe("far");
  });

  it("funktioniert auch ohne eigene Zeit (time 0, z. B. Explore)", () => {
    const f = runFeasibility({ dist: 1000, time: 0, komTime: 225 }, curve)!;
    expect(f.status).toBe("attack");
    expect(f.gap).toBeUndefined();
  });

  it("gibt null ohne CR-Zeit oder ohne Kurve", () => {
    expect(runFeasibility({ dist: 1000, time: 300, komTime: null }, curve)).toBeNull();
    expect(runFeasibility({ dist: 1000, time: 300, komTime: 225 }, [])).toBeNull();
  });
});

describe("fmtPace", () => {
  it("formatiert m/s als min/km", () => {
    expect(fmtPace(1000 / 240)).toBe("4:00 /km");
    expect(fmtPace(1000 / 272)).toBe("4:32 /km");
  });
  it("gibt Platzhalter fuer fehlende Werte", () => {
    expect(fmtPace(null)).toBe("-");
    expect(fmtPace(0)).toBe("-");
  });
});

describe("physicsKomWatts", () => {
  it("liefert plausible Werte fuer einen Anstieg", () => {
    // 5 km, 400 hm (8 %), KOM 20 min, 71 kg: dominiert von der Steigleistung
    const w = physicsKomWatts(5000, 400, 1200, 71)!;
    // reine Steigleistung: 80 kg * 9.81 * 400 m / 1200 s = ~262 W, plus Roll/Aero
    expect(w).toBeGreaterThan(270);
    expect(w).toBeLessThan(340);
  });

  it("liefert plausible Werte im Flachen (Aero dominiert)", () => {
    // 5 km flach, KOM 6 min = 50 km/h: braucht deutlich ueber 400 W
    const w = physicsKomWatts(5000, 0, 360, 71)!;
    expect(w).toBeGreaterThan(400);
  });

  it("skaliert mit dem Gewicht am Berg", () => {
    const light = physicsKomWatts(5000, 400, 1200, 60)!;
    const heavy = physicsKomWatts(5000, 400, 1200, 90)!;
    expect(heavy).toBeGreaterThan(light);
  });

  it("gibt null fuer unplausible Eingaben", () => {
    expect(physicsKomWatts(0, 100, 600, 71)).toBeNull();
    expect(physicsKomWatts(5000, 0, 0, 71)).toBeNull();
    expect(physicsKomWatts(5000, 0, 600, 0)).toBeNull();
  });
});
