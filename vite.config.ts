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
  define: {
    // Version aus package.json (npm setzt diese Variable bei "npm run …").
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
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
