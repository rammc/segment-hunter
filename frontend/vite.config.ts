import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "/" passt fuer die Custom Domain (hunter-kom.com) auf GitHub Pages.
// Fuer ein Projekt-Pages-Deployment ohne Domain: VITE_BASE=/segment-hunter/ setzen.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
});
