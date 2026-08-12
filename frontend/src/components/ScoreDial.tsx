import { T, mono } from "../theme";

export function ScoreDial({ score }: { score: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const col = score >= 65 ? T.gold : score >= 40 ? T.teal : T.faint;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`Hunt-Score ${score}`}>
      <circle cx="36" cy="36" r={r} stroke={T.line} strokeWidth="6" fill="none" />
      <circle
        cx="36"
        cy="36"
        r={r}
        stroke={col}
        strokeWidth="6"
        fill="none"
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 36 36)"
      />
      <text
        x="36"
        y="41"
        textAnchor="middle"
        fill={T.text}
        fontSize="18"
        style={{ ...mono, fontWeight: 700 }}
      >
        {score}
      </text>
    </svg>
  );
}
