import type { CSSProperties } from "react";

/* Design-Tokens aus dem Prototyp (Head-Unit-Stil) */
export const T = {
  bg: "#12161B",
  panel: "#1A2129",
  line: "#2C3743",
  text: "#E9EDF1",
  dim: "#8B98A5",
  faint: "#5A6773",
  gold: "#E8B93C",
  goldSoft: "#E8B93C22",
  teal: "#4FB6A8",
  red: "#E06C55",
} as const;

export const display: CSSProperties = { fontFamily: "'Saira Condensed', sans-serif" };
export const body: CSSProperties = { fontFamily: "'Saira', sans-serif" };
export const mono: CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
