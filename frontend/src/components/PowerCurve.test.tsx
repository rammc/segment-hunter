import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/* Sprache deterministisch auf EN pinnen, unabhaengig vom Host-Locale */
vi.stubGlobal("localStorage", {
  getItem: () => "en",
  setItem: () => {},
  removeItem: () => {},
});
import { I18nProvider } from "../lib/i18n";
import { PowerCurve } from "./PowerCurve";
import { CurveSupportTable } from "./CurveSupportTable";
import type { CurvePoint, CurveSupport, TargetMark } from "../lib/types";

const ACT = { id: 987654, name: "Sonntagsrunde", date: "2026-08-09" };

/* Envelope mit Plateau-Spam, wie ihn buildPowerCurve nach der
   Monotonie-Korrektur liefert */
const curve: CurvePoint[] = [
  [5, 620],
  [30, 480],
  [60, 400],
  ...Array.from({ length: 120 }, (_, i) => [90 + i * 20, 300] as CurvePoint),
  [3600, 240],
];

const supports: CurveSupport[] = [
  { sec: 5, value: 620, kind: "stream", activity: ACT },
  { sec: 60, value: 400, kind: "stream", activity: ACT },
  { sec: 300, value: 300, kind: "effort", activity: ACT },
  { sec: 1200, value: 274, kind: "ftp", activity: null },
];

const targets: TargetMark[] = [
  { name: "Kanalbruecke", sec: 95, value: 350, have: 360, feasible: true },
  { name: "Teufelsberg", sec: 600, value: 420, have: 300, feasible: false },
];

function render(ui: React.ReactElement) {
  return renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>);
}

describe("PowerCurve rendering", () => {
  const html = render(
    <PowerCurve
      curve={curve}
      weight={71}
      sport="ride"
      supports={supports}
      targets={targets}
      estimatedFrom={300}
    />
  );

  it("duennt die Punktwolke aus statt jeden Envelope-Punkt zu markieren", () => {
    const circles = (html.match(/<circle/g) ?? []).length;
    // 3 Support-Marker (ftp ist eine Raute) + 2 Ziele, kein 120-Punkte-Band
    expect(circles).toBeLessThan(10);
  });

  it("zeichnet eine beschriftete Y-Achse mit W und W/kg", () => {
    expect(html).toContain(">W<");
    expect(html).toContain("W/kg");
  });

  it("rendert den geschaetzten Kurventeil gestrichelt plus Legende", () => {
    expect(html).toContain('stroke-dasharray="6 5"');
    expect(html).toContain("estimated (effort/FTP)");
  });

  it("legt KOM-Ziele als Punkte mit Tooltip ueber die Kurve", () => {
    expect(html).toContain("Kanalbruecke");
    expect(html).toContain("Teufelsberg");
    expect(html).toContain("needs ≈420 W");
  });

  it("zeichnet den FTP-Anker als Raute", () => {
    expect(html).toContain("rotate(45");
  });
});

describe("CurveSupportTable", () => {
  const html = render(<CurveSupportTable supports={supports} sport="ride" weight={71} />);

  it("verlinkt die Herkunfts-Einheit auf Strava", () => {
    expect(html).toContain("https://www.strava.com/activities/987654");
    expect(html).toContain("Sonntagsrunde");
  });

  it("zeigt Bestwert in W und W/kg sowie die Quelle", () => {
    expect(html).toContain("400 W");
    expect(html).toContain("5.6 W/kg");
    expect(html).toContain("Watt stream");
    expect(html).toContain("FTP (profile)");
  });
});
