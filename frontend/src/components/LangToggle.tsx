import { T, display } from "../theme";
import { useI18n } from "../lib/i18n";
import type { Lang } from "../lib/i18n";

const OPTIONS: Lang[] = ["de", "en"];

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t.langGroup}
      style={{
        display: "inline-flex",
        border: `1px solid ${T.line}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {OPTIONS.map((l) => {
        const active = l === lang;
        return (
          <button
            key={l}
            onClick={() => !active && setLang(l)}
            aria-pressed={active}
            style={{
              ...display,
              background: active ? T.gold : "transparent",
              color: active ? "#1A1608" : T.dim,
              border: "none",
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              cursor: active ? "default" : "pointer",
            }}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}
