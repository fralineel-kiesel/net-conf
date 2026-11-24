import { defineConfig } from "vite";

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
  build: {
    // WebView2 auf Windows 11 ist Chromium-basiert und aktuell.
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
