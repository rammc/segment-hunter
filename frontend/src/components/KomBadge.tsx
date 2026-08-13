import { T, display } from "../theme";
import { useI18n } from "../lib/i18n";
import type { Feasibility, FeasibilityStatus } from "../lib/types";

const STYLE: Record<FeasibilityStatus, { bg: string; fg: string }> = {
  kom: { bg: T.gold, fg: "#1A1608" },
  attack: { bg: T.gold, fg: "#1A1608" },
  train: { bg: T.teal, fg: "#0E1B19" },
  far: { bg: T.line, fg: T.dim },
};

export function KomBadge({ feas }: { feas: Feasibility | null }) {
  const { t } = useI18n();
  if (!feas) return null;
  const s = STYLE[feas.status];
  const label: Record<FeasibilityStatus, string> = {
    kom: t.badgeKom,
    attack: t.badgeAttack,
    train: t.badgeTrain,
    far: t.badgeFar,
  };
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
      {label[feas.status]}
    </span>
  );
}
