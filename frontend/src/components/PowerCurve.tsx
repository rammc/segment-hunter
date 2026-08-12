import { T, mono } from "../theme";
import { fmtTime } from "../lib/scoring";
import type { CurvePoint } from "../lib/types";

export function PowerCurve({ curve, weight }: { curve: CurvePoint[]; weight: number }) {
  if (!curve.length) return null;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  const W = 560,
    H = 180,
    P = 34;
  const xs = sorted.map(([s]) => Math.log(s));
  const ws = sorted.map(([, w]) => w);
  const xMin = Math.min(...xs),
    xMax = Math.max(...xs);
  const wMax = Math.max(...ws) * 1.1;
  const px = (s: number) => P + ((Math.log(s) - xMin) / (xMax - xMin || 1)) * (W - 2 * P);
  const py = (w: number) => H - P - (w / wMax) * (H - 2 * P);
  const path = sorted
    .map(([s, w], i) => `${i ? "L" : "M"}${px(s).toFixed(1)},${py(w).toFixed(1)}`)
    .join(" ");
  const ticks = [5, 30, 120, 600, 3600].filter(
    (s) => s >= sorted[0][0] && s <= sorted[sorted.length - 1][0]
  );
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto" }}
      role="img"
      aria-label="Power-Kurve"
    >
      {ticks.map((s) => (
        <g key={s}>
          <line x1={px(s)} y1={P} x2={px(s)} y2={H - P} stroke={T.line} strokeDasharray="2 4" />
          <text x={px(s)} y={H - P + 16} textAnchor="middle" fill={T.faint} fontSize="10" style={mono}>
            {s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : "1h"}
          </text>
        </g>
      ))}
      <path d={path} stroke={T.gold} strokeWidth="2.5" fill="none" />
      {sorted.map(([s, w]) => (
        <circle key={s} cx={px(s)} cy={py(w)} r="3" fill={T.bg} stroke={T.gold} strokeWidth="2">
          <title>{`${fmtTime(s)}: ${w} W (${(w / weight).toFixed(1)} W/kg)`}</title>
        </circle>
      ))}
    </svg>
  );
}
