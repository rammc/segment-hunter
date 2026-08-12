import { T, mono } from "../theme";

export function Field({
  label,
  value,
  onChange,
  secret = false,
  placeholder,
  flex = "1 1 260px",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  placeholder?: string;
  flex?: string;
}) {
  return (
    <label style={{ display: "block", flex }}>
      <span
        style={{
          color: T.faint,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          display: "block",
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          ...mono,
          width: "100%",
          boxSizing: "border-box",
          background: T.bg,
          color: T.text,
          border: `1px solid ${T.line}`,
          borderRadius: 8,
          padding: "10px 12px",
          fontSize: 13,
        }}
      />
    </label>
  );
}
