import { T, display } from "../theme";
import type { Feasibility, FeasibilityStatus } from "../lib/types";

const MAP: Record<FeasibilityStatus, { label: string; bg: string; fg: string }> = {
  kom: { label: "DU HÄLTST DEN KOM", bg: T.gold, fg: "#1A1608" },
  attack: { label: "KOM IN REICHWEITE", bg: T.gold, fg: "#1A1608" },
  train: { label: "MIT TRAINING MACHBAR", bg: T.teal, fg: "#0E1B19" },
  far: { label: "AUSSER REICHWEITE", bg: T.line, fg: T.dim },
};

export function KomBadge({ feas }: { feas: Feasibility | null }) {
  if (!feas) return null;
  const s = MAP[feas.status];
  return (
    <span
      style={{
        ...display,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.8,
        padding: "3px 8px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}
