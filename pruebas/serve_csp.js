// Sirve el build con EXACTAMENTE las cabeceras de client/vercel.json.
//
// `vite preview` no las aplica, así que sin esto la CSP se estrenaría en
// producción -- y una CSP mal puesta rompe la app entera sin avisar antes.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../client/dist");
const CONF = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../client/vercel.json"), "utf8"));
const HEADERS = CONF.headers[0].headers;
// Cabeceras por archivo (Cache-Control del sw, MIME del perfil de Apple…).
const PORARCHIVO = CONF.headers.slice(1);

const TYPES = {
  ".webmanifest": "application/manifest+json",
  ".zip": "application/zip",
  ".mobileconfig": "application/x-apple-aspen-config",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    for (const h of HEADERS) {
      let value = h.value;
      // ÚNICA diferencia con producción: allí la API es https (Render) y la
      // cubre `connect-src https: wss:`; acá corre en http sobre localhost.
      if (h.key === "Content-Security-Policy") {
        value = value.replace("connect-src 'self'", "connect-src 'self' http://localhost:4001 ws://localhost:4001");
      }
      res.setHeader(h.key, value);
    }
    for (const regla of PORARCHIVO) {
      if (regla.source === urlPath) {
        for (const h of regla.headers) res.setHeader(h.key, h.value);
      }
    }
    let file = path.join(ROOT, urlPath);
    // Igual que el rewrite de Vercel: cualquier ruta desconocida es la SPA.
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
    // Las reglas por archivo de vercel.json ganan; si no, decide la extensión.
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    }
    res.end(fs.readFileSync(file));
  })
  .listen(4174, () => console.log("build servido con las cabeceras de vercel.json en :4174"));
