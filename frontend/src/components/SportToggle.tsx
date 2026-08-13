import { T, display } from "../theme";
import { useI18n } from "../lib/i18n";
import type { Sport } from "../lib/types";

export function SportToggle({
  sport,
  onChange,
  disabled = false,
}: {
  sport: Sport;
  onChange: (s: Sport) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const OPTIONS: Array<{ value: Sport; label: string }> = [
    { value: "ride", label: t.sportRide },
    { value: "run", label: t.sportRun },
  ];
  return (
    <div
      role="group"
      aria-label={t.sportGroup}
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
