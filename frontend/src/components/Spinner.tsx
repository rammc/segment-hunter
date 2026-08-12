import { T } from "../theme";

export function Spinner() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 28,
          height: 28,
          border: `3px solid ${T.line}`,
          borderTopColor: T.gold,
          borderRadius: "50%",
          animation: "sh-spin 0.9s linear infinite",
        }}
      />
      <style>{`@keyframes sh-spin{to{transform:rotate(360deg)}} @media (prefers-reduced-motion: reduce){*{animation:none!important}}`}</style>
    </>
  );
}
