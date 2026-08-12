import { T } from "../theme";

export function Crown({ size = 18, color = T.gold }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 18h18l-1.4-9-4.6 4L12 5l-3 8-4.6-4L3 18z" fill={color} />
    </svg>
  );
}
