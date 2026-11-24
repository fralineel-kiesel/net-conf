import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Version direkt aus package.json lesen (gleiche Nummer wie Cargo.toml und
// tauri.conf.json) – funktioniert auch, wenn Vite nicht über npm gestartet wird.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

// Vite-Konfiguration nach Tauri-v2-Vorlage.
// TAURI_DEV_HOST wird nur für Mobile-Entwicklung gebraucht – hier egal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // WebView2 auf Windows 11 ist Chromium-basiert und aktuell.
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
