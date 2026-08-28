/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// El sello del build (lo inyecta vite.config.ts en `define`).
declare const __UNIFY_BUILD__: string;

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
