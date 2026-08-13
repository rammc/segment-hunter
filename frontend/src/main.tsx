import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./lib/i18n";
import SegmentHunter from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <SegmentHunter />
    </I18nProvider>
  </StrictMode>
);
