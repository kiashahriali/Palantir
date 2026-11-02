import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-root-pwa-assets",
      closeBundle() {
        const out = resolve(process.cwd(), "dist");
        for (const file of ["manifest.webmanifest", "sw.js", "icon.svg"]) {
          copyFileSync(resolve(process.cwd(), file), resolve(out, file));
        }
      }
    }
  ],
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist" }
});
