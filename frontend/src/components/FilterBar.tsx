import { T, body } from "../theme";

export interface FilterOption<V extends string> {
  value: V;
  label: string;
}

export function FilterChips<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: Array<FilterOption<V>>;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span
        style={{
          color: T.faint,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          marginRight: 2,
        }}
      >
        {label}
      </span>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            style={{
              ...body,
              background: active ? T.goldSoft : "transparent",
              color: active ? T.gold : T.dim,
              border: `1px solid ${active ? T.gold + "88" : T.line}`,
              borderRadius: 999,
              padding: "4px 12px",
              fontSize: 13,
              cursor: active ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
