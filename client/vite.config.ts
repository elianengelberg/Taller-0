import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// simple-peer's dependencies (readable-stream, buffer) expect the Node
// `global` identifier to exist. `src/polyfills.ts` (imported first in
// main.tsx) provides `process`/`Buffer` at runtime.
export default defineConfig({
  plugins: [
    react(),
    // Unify instalable como app (escritorio y Android). Reglas del service
    // worker, en orden de importancia:
    //
    //  1. La API y el socket NO se cachean jamás: servir historial viejo desde
    //     un caché es corromper datos, y el socket ni siquiera se puede.
    //  2. Los bundles gigantes (SDK de Zoom ~5,6 MB, embebidos ~3 MB) quedan
    //     FUERA del precache: instalar la app no puede costar 10 MB que quizá
    //     nunca se usen. Se cachean en runtime la primera vez que alguien
    //     abre un embed.
    //  3. La actualización es con PERMISO (registerType "prompt"): un
    //     skipWaiting automático intercambia los chunks a mitad de una
    //     reunión en vivo. src/pwa.ts sólo ofrece actualizar fuera de
    //     /reunion y /externa/reunion.
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Unify — Reuniones sin barreras",
        short_name: "Unify",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#F8FAFC",
        theme_color: "#F8FAFC",
        lang: "es-AR",
        description:
          "Videollamadas con transcripción, traducción en vivo y grabación — también sobre Zoom, Meet y Teams.",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // focus-existing y NO navigate-existing: navegar la ventana existente
        // destruiría una reunión en curso. src/pwa.ts consume launchQueue y
        // decide con criterio (navega sólo si no hay reunión activa).
        launch_handler: { client_mode: "focus-existing" },
        // Compartir un enlace de Zoom/Meet desde cualquier app de Android ->
        // Unify -> cae en /externa ya detectado. El enlace suele venir en
        // `text`, no en `url`: ExternalJoin mira los dos.
        share_target: {
          action: "/externa",
          method: "GET",
          params: { url: "url", text: "text", title: "title" },
        },
        shortcuts: [
          { name: "Unirme a una reunión externa", url: "/externa" },
          { name: "Mi historial", url: "/historial" },
        ],
      },
      workbox: {
        // Regla 2: los bundles pesados no entran al precache.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        globIgnores: ["**/sdk.bundle-*.js", "**/embedded-*.js"],
        // El precache igual referencia esos chunks desde el grafo de imports;
        // subir el tope evita que Workbox los tire con un warning confuso.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Regla 1: nada de la API pasa por el service worker.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /socket\.io/],
        runtimeCaching: [
          {
            // Los bundles pesados excluidos del precache: primera visita los
            // baja, después salen del caché (tienen hash: son inmutables).
            urlPattern: /\/assets\/(sdk\.bundle|embedded)-.*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "unify-bundles-pesados",
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-hojas" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-archivos",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
  },
  define: {
    global: "globalThis",
  },
});
