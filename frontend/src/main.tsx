import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SegmentHunter from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SegmentHunter />
  </StrictMode>
);
