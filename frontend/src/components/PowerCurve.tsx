import { useState } from "react";
import { T, body, mono } from "../theme";
import { displayCurve, fmtPace, fmtTime, interpolateAt } from "../lib/scoring";
import { useI18n } from "../lib/i18n";
import type { CurvePoint, CurveSupport, Sport, TargetMark } from "../lib/types";

/**
 * Rad: Watt ueber Dauer. Laufen: Geschwindigkeit (angezeigt als Pace) ueber
 * Dauer. Gezeichnet wird die ausgeduennte Kurve (displayCurve), Marker nur
 * auf den Standard-Stuetzstellen. Ab `estimatedFrom` ist die Linie
 * gestrichelt (FTP-Anker/Effort-Fallback bzw. Riegel-Extrapolation).
 * KOM-/CR-Ziele liegen als Punkte ueber der Kurve: gold = machbar.
 */
export function PowerCurve({
  curve,
  weight,
  sport = "ride",
  supports = [],
  targets = [],
  estimatedFrom = null,
}: {
  curve: CurvePoint[];
  weight: number;
  sport?: Sport;
  supports?: CurveSupport[];
  targets?: TargetMark[];
  estimatedFrom?: number | null;
}) {
  const { t } = useI18n();
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  if (!curve.length) return null;

  const pts = displayCurve(curve);
  const isRide = sport === "ride";
  const crLabel = isRide ? "KOM" : "CR";

  const W = 560,
    H = 220,
    PL = 44,
    PR = isRide ? 46 : 14,
    PT = 14,
    PB = 30;

  const xMin = Math.log(pts[0][0]);
  const xMax = Math.log(pts[pts.length - 1][0]);
  const xSpan = xMax - xMin || 1;
  const inDomain = (sec: number) => sec >= pts[0][0] && sec <= pts[pts.length - 1][0];

  const shownTargets = targets.filter((tg) => inDomain(tg.sec));
  const vMax =
    Math.max(...pts.map(([, v]) => v), ...shownTargets.map((tg) => tg.value)) * 1.08;

  const px = (s: number) => PL + ((Math.log(s) - xMin) / xSpan) * (W - PL - PR);
  const py = (v: number) => H - PB - (v / vMax) * (H - PT - PB);

  const pathOf = (points: CurvePoint[]) =>
    points.map(([s, v], i) => `${i ? "L" : "M"}${px(s).toFixed(1)},${py(v).toFixed(1)}`).join(" ");

  /* Linie am Schaetzungs-Beginn in solide und gestrichelte Haelfte teilen */
  let solidPts: CurvePoint[] = pts;
  let dashedPts: CurvePoint[] = [];
  if (estimatedFrom != null && inDomain(estimatedFrom)) {
    const bv = interpolateAt(curve, estimatedFrom);
    solidPts = pts.filter(([s]) => s < estimatedFrom);
    dashedPts = pts.filter(([s]) => s > estimatedFrom);
    if (bv != null) {
      solidPts = [...solidPts, [estimatedFrom, bv]];
      dashedPts = [[estimatedFrom, bv], ...dashedPts];
    }
  } else if (estimatedFrom != null && estimatedFrom <= pts[0][0]) {
    solidPts = [];
    dashedPts = pts;
  }

  /* Y-Gridlines: 3 bis 5 runde Schritte */
  const rawStep = vMax / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = ([1, 2, 2.5, 5, 10].find((m) => rawStep <= m * pow) ?? 10) * pow;
  const gridVals: number[] = [];
  for (let v = step; v <= vMax; v += step) gridVals.push(v);

  const X_TICKS = [5, 30, 120, 600, 1800, 3600, 7200, 14400].filter(inDomain);
  const xTickLabel = (s: number) =>
    s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`;
  const paceShort = (v: number) => fmtPace(v).replace(" /km", "");
  const yLabel = (v: number) => (isRide ? `${Math.round(v)}` : paceShort(v));

  const valueLine = (sec: number, v: number) =>
    isRide
      ? `${fmtTime(sec)} · ${Math.round(v)} W (${(v / weight).toFixed(1)} W/kg)`
      : `${fmtTime(sec)} · ${fmtPace(v)}`;

  const shownSupports = supports.filter((s) => inDomain(s.sec));
  const hasFtp = shownSupports.some((s) => s.kind === "ftp");
  const hoverVal = hoverSec != null ? interpolateAt(curve, hoverSec) : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < PL || x > W - PR) {
      setHoverSec(null);
      return;
    }
    const sec = Math.exp(xMin + ((x - PL) / (W - PL - PR)) * xSpan);
    setHoverSec(sec);
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label={t.curveAria(sport)}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverSec(null)}
      >
        {/* Y-Gridlines mit Beschriftung: links W bzw. Pace, rechts W/kg */}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PL} y1={py(v)} x2={W - PR} y2={py(v)} stroke={T.line} strokeDasharray="2 4" />
            <text x={PL - 6} y={py(v) + 3} textAnchor="end" fill={T.faint} fontSize="9" style={mono}>
              {yLabel(v)}
            </text>
            {isRide && (
              <text x={W - PR + 6} y={py(v) + 3} textAnchor="start" fill={T.faint} fontSize="9" style={mono}>
                {(v / weight).toFixed(1)}
              </text>
            )}
          </g>
        ))}
        {/* Achsen-Einheiten */}
        <text x={PL - 6} y={PT - 3} textAnchor="end" fill={T.faint} fontSize="9" style={mono}>
          {isRide ? "W" : "/km"}
        </text>
        {isRide && (
          <text x={W - PR + 6} y={PT - 3} textAnchor="start" fill={T.faint} fontSize="9" style={mono}>
            W/kg
          </text>
        )}

        {/* X-Ticks */}
        {X_TICKS.map((s) => (
          <g key={s}>
            <line x1={px(s)} y1={PT} x2={px(s)} y2={H - PB} stroke={T.line} strokeDasharray="2 4" />
            <text x={px(s)} y={H - PB + 14} textAnchor="middle" fill={T.faint} fontSize="10" style={mono}>
              {xTickLabel(s)}
            </text>
          </g>
        ))}

        {/* Kurve: solide = gemessen, gestrichelt = Schaetzung */}
        {solidPts.length > 1 && (
          <path d={pathOf(solidPts)} stroke={T.gold} strokeWidth="2.5" fill="none" />
        )}
        {dashedPts.length > 1 && (
          <path
            d={pathOf(dashedPts)}
            stroke={T.gold}
            strokeWidth="2"
            strokeDasharray="6 5"
            fill="none"
            opacity="0.8"
          />
        )}

        {/* Marker nur auf den Standard-Stuetzstellen; FTP-Anker als Raute */}
        {shownSupports.map((s) => {
          const cy = py(interpolateAt(curve, s.sec) ?? s.value);
          const cx = px(s.sec);
          return s.kind === "ftp" ? (
            <rect
              key={s.sec}
              x={cx - 3.5}
              y={cy - 3.5}
              width={7}
              height={7}
              transform={`rotate(45 ${cx} ${cy})`}
              fill={T.bg}
              stroke={T.faint}
              strokeWidth="1.5"
            >
              <title>{valueLine(s.sec, s.value)}</title>
            </rect>
          ) : (
            <circle key={s.sec} cx={cx} cy={cy} r="3" fill={T.bg} stroke={T.gold} strokeWidth="2">
              <title>{valueLine(s.sec, s.value)}</title>
            </circle>
          );
        })}

        {/* KOM-/CR-Ziele: benoetigter Wert auf der KOM-Dauer */}
        {shownTargets.map((tg, i) => (
          <circle
            key={`${tg.name}-${i}`}
            cx={px(tg.sec)}
            cy={py(tg.value)}
            r="4"
            fill={tg.feasible ? T.gold : T.faint}
            opacity={tg.feasible ? 1 : 0.75}
          >
            <title>
              {`${tg.name} · ${fmtTime(tg.sec)} · ${
                isRide
                  ? t.needHaveWatts(Math.round(tg.value), Math.round(tg.have))
                  : t.needHavePace(fmtPace(tg.value), fmtPace(tg.have))
              }`}
            </title>
          </circle>
        ))}

        {/* Hover-Crosshair */}
        {hoverSec != null && hoverVal != null && (
          <g pointerEvents="none">
            <line x1={px(hoverSec)} y1={PT} x2={px(hoverSec)} y2={H - PB} stroke={T.dim} strokeWidth="1" />
            <circle cx={px(hoverSec)} cy={py(hoverVal)} r="3.5" fill={T.gold} />
            <text
              x={Math.min(Math.max(px(hoverSec), PL + 80), W - PR - 80)}
              y={PT + 9}
              textAnchor="middle"
              fill={T.text}
              fontSize="11"
              style={mono}
            >
              {valueLine(hoverSec, hoverVal)}
            </text>
          </g>
        )}
      </svg>

      {/* Legende */}
      <div
        style={{
          ...body,
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 16px",
          color: T.faint,
          fontSize: 12,
          marginTop: 4,
        }}
      >
        <span>
          <span style={{ display: "inline-block", width: 18, borderTop: `2.5px solid ${T.gold}`, verticalAlign: "middle", marginRight: 6 }} />
          {t.legendMeasured}
        </span>
        {(dashedPts.length > 1 || estimatedFrom != null) && (
          <span>
            <span style={{ display: "inline-block", width: 18, borderTop: `2px dashed ${T.gold}`, verticalAlign: "middle", marginRight: 6 }} />
            {t.legendEstimated(sport)}
          </span>
        )}
        {hasFtp && (
          <span>
            <span style={{ display: "inline-block", width: 7, height: 7, border: `1.5px solid ${T.faint}`, transform: "rotate(45deg)", verticalAlign: "middle", marginRight: 6 }} />
            {t.legendFtp}
          </span>
        )}
        {shownTargets.length > 0 && (
          <>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: T.gold, verticalAlign: "middle", marginRight: 6 }} />
              {t.legendTargetFeasible(crLabel)}
            </span>
            <span>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: T.faint, verticalAlign: "middle", marginRight: 6 }} />
              {t.legendTargetFar(crLabel)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
