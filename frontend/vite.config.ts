import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Projekt-Pages-Deployment: die Seite lebt unter
// https://rammc.github.io/segment-hunter/. Lokal (npm run dev) gilt "/".
// Ueber VITE_BASE laesst sich der Pfad ueberschreiben, z. B. "/" fuer
// eine spaetere Custom Domain.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: process.env.VITE_BASE || (command === "build" ? "/segment-hunter/" : "/"),
}));
