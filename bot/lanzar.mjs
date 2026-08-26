#!/usr/bin/env node
// El lanzador cómodo del Notetaker: UN comando con el link de la reunión.
//
//   node bot/lanzar.mjs "https://meet.jit.si/MiSala"
//   node bot/lanzar.mjs "https://meet.google.com/abc-defg-hij" "Unify Notetaker"
//
// Deriva plataforma y clave de sala con LAS MISMAS reglas que la web
// (detectMeetingPlatform en client/src/lib/meetingPlatforms.ts), así el bot y
// las personas que abren "Unify al lado" caen en UNA sola sala, un solo hilo
// de transcripción. Después arranca joinbot.mjs con todo puesto.
//
// Variables opcionales (se respetan si ya vienen puestas):
//   SERVER_URL        default https://taller-0.onrender.com (producción)
//   BOT_PROFILE_DIR   perfil de Chrome con la cuenta de Google (para Meet)
//   ROOM_KEY          para forzar una clave distinta de la derivada

const link = (process.argv[2] || "").trim();
const nombre = (process.argv[3] || process.env.BOT_NAME || "Unify Notetaker").trim();

if (!link) {
  console.error('Uso:  node bot/lanzar.mjs "<link de la reunión>" ["nombre del bot"]');
  console.error('Ej.:  node bot/lanzar.mjs "https://meet.jit.si/MiSala"');
  process.exit(2);
}

function detectar(raw) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  // Zoom: el número va tras /j/, /w/ o /wc/(join/); puede venir con guiones.
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    const id = url.pathname
      .replace(/(\d)[\s-](?=\d)/g, "$1")
      .match(/\/(?:j|w|wc)\/(?:join\/)?(\d{9,11})/)?.[1];
    if (!id) {
      return { error: "Ese link de Zoom no trae el número de reunión (los /my/ de vanidad no lo tienen). Pasame el link con /j/<número>." };
    }
    return { plataforma: "zoom-web", clave: `zoom:${id}`, url: url.toString() };
  }

  // Google Meet: el código abc-defg-hij. El query se descarta a propósito
  // (trae parámetros por persona: authuser, pli...).
  if (host === "meet.google.com") {
    const code = url.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)?.[1]?.toLowerCase();
    if (!code) return { error: "Ese link de Meet no trae el código (abc-defg-hij)." };
    return { plataforma: "google-meet", clave: `google-meet:${code}`, url: `https://meet.google.com/${code}` };
  }

  // Familia Jitsi: meet.jit.si, 8x8.vc (la sala es inquilino/sala, DOS tramos)
  // o una instalación propia en jitsi.<empresa>. La clave lleva el dominio y
  // la sala en minúsculas, igual que la web.
  const esJitsi =
    host === "meet.jit.si" || host === "8x8.vc" || host.endsWith(".8x8.vc") || /(^|\.)jitsi\./.test(host);
  if (esJitsi) {
    const seg = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    const take = host === "8x8.vc" || host.endsWith(".8x8.vc") ? 2 : 1;
    const crudo = seg.slice(0, take).join("/");
    if (!crudo) return { error: "Ese link de Jitsi no trae el nombre de la sala." };
    let sala = crudo;
    try { sala = decodeURIComponent(crudo); } catch { /* queda como vino */ }
    return { plataforma: "jitsi", clave: `jitsi:${host}/${sala.toLowerCase()}`, url: url.toString() };
  }

  return {
    error:
      "Por ahora el bot sabe entrar a Jitsi, Google Meet y Zoom. " +
      "Para otras plataformas entrá vos: la extensión detecta la reunión y la graba igual.",
  };
}

const det = detectar(link);
if (!det) {
  console.error("Eso no parece un link válido de reunión.");
  process.exit(2);
}
if (det.error) {
  console.error(det.error);
  process.exit(2);
}

// Para las pruebas: sólo mostrar qué derivó, sin lanzar el navegador.
if (process.env.SOLO_DETECTAR) {
  console.log(JSON.stringify({ plataforma: det.plataforma, clave: det.clave, url: det.url }));
  process.exit(0);
}

process.env.MEETING_URL = det.url;
process.env.ROOM_KEY = process.env.ROOM_KEY || det.clave;
process.env.PLATFORM = det.plataforma;
process.env.BOT_NAME = nombre;
process.env.SERVER_URL = process.env.SERVER_URL || "https://taller-0.onrender.com";

if (det.plataforma === "google-meet" && !process.env.BOT_PROFILE_DIR) {
  console.log(
    "[lanzar] Aviso: Meet suele rebotar a los invitados anónimos. Si no entra, " +
      "prepará el perfil de Google (bot/README.md, sección 3) y volvé a correr " +
      "con BOT_PROFILE_DIR=/ruta/al/perfil."
  );
}

console.log(`[lanzar] plataforma=${det.plataforma}  sala=${process.env.ROOM_KEY}`);
console.log(`[lanzar] servidor=${process.env.SERVER_URL}  nombre=${nombre}`);
await import("./joinbot.mjs");
