import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// simple-peer's dependencies (readable-stream, buffer) expect the Node
// `global` identifier to exist. `src/polyfills.ts` (imported first in
// main.tsx) provides `process`/`Buffer` at runtime.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  define: {
    global: "globalThis",
  },
});
