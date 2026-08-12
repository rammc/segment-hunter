import { T, display } from "../theme";
import type { Sport } from "../lib/types";

const OPTIONS: Array<{ value: Sport; label: string }> = [
  { value: "ride", label: "Rad" },
  { value: "run", label: "Laufen" },
];

export function SportToggle({
  sport,
  onChange,
  disabled = false,
}: {
  sport: Sport;
  onChange: (s: Sport) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Sportart"
      style={{
        display: "inline-flex",
        border: `1px solid ${T.line}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {OPTIONS.map((o) => {
        const active = o.value === sport;
        return (
          <button
            key={o.value}
            onClick={() => !active && onChange(o.value)}
            disabled={disabled}
            aria-pressed={active}
            style={{
              ...display,
              background: active ? T.gold : "transparent",
              color: active ? "#1A1608" : T.dim,
              border: "none",
              padding: "8px 18px",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              cursor: disabled || active ? "default" : "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
