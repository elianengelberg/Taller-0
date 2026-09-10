// LA REUNIÓN QUE NO SE GRABÓ, Y NO LO DICE.
//
// Reporte real, con la foto del historial en la mano: «y la grabación no se
// realizó, ya te dije que debe de ser automática la grabación». En la
// pantalla de la reunión guardada no había NADA sobre la grabación: ni
// reproductor, ni aviso, ni motivo. El bloque entero se escondía cuando la
// reunión no tenía `recordingUrl`, así que un hueco en blanco tenía que
// hacer de explicación.
//
// Un hueco no explica nada. Desde afuera son indistinguibles:
//   · nadie apretó grabar,
//   · se grabó y la subida se perdió,
//   · el servidor no tiene dónde guardar videos,
//   · el bot no pudo capturar la pantalla.
// Y las cuatro terminan en la misma conclusión equivocada: «esta app no
// graba». El motivo existía -- lo sabía el bot, o el servidor al rechazar la
// subida --, pero vivía en el journal del host y en un Map en memoria que se
// borra con cada reinicio. Ninguno de los dos se puede mirar desde el
// historial una semana después.
//
// Esta suite exige que el motivo VIAJE hasta la fila de la reunión y se LEA
// en la pantalla, y que desaparezca solo cuando por fin hay video.
const { execFileSync } = require("child_process");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
// Sin nombre a propósito: el arnés se lo pega al final del renglón del
// resumen, y la batería junta ese renglón con un grep anclado en "OK$" --
// con el nombre detrás, la columna del resumen quedaba vacía.
const { check, resumen } = require("./lib/arnes")();

const API = "http://localhost:4001";
const B = "http://localhost:4174";
const DB_URL = "postgres://postgres@localhost:5433/unify";

// Las funciones de verdad del servidor sobre la base de verdad.
const enLaBase = (accion, dbId, valor = "") =>
  JSON.parse(
    execFileSync(
      "server/node_modules/.bin/tsx",
      ["pruebas/grabacion_helper.ts", accion, dbId, valor],
      { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: "utf8" }
    ).trim().split("\n").pop()
  );

const jsonp = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// LA REUNIÓN RECIÉN NACIDA TARDA UN INSTANTE EN SER LEÍBLE.
//
// Una sala companion existe en memoria apenas se la pide, y en la base un
// momento después: `/session` crea la fila y la pone a tu nombre sin esperar
// (fire-and-forget, con su propia paciencia adentro). Leer el historial en
// ese hueco devuelve 404 -- que es exactamente lo que le pasó a esta suite
// cuando la corrió una máquina cargada. La app real nunca lo nota (entre
// entrar a la reunión y abrir el historial pasan minutos); una prueba que
// mide en milisegundos, sí. Así que se espera a que la reunión esté, y
// recién ahí se prueba lo que esta suite vino a probar.
async function esperarReunion(dbId, token, intentos = 25) {
  for (let i = 0; i < intentos; i++) {
    const r = await fetch(`${API}/api/meetings/${dbId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return (await r.json()).meeting ?? null;
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}

(async () => {
  // Una cuenta, y una sala externa a su nombre (por ahí pasa el bot).
  const reg = await fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `grab${Date.now()}@test.com`, password: "melon42Trueno", name: "Testigo" }),
  }).then((r) => r.json());
  check("hay una cuenta para mirar su historial", Boolean(reg.token));

  const sala = `google-meet:zzz-${Date.now().toString(36).slice(-4)}-yyy`;
  const ses = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(sala)}/session`, {
    headers: { Authorization: `Bearer ${reg.token}` },
  }).then((r) => r.json());
  const dbId = ses.dbId;
  check("la sala externa tiene su reunión de respaldo", Boolean(dbId), String(dbId));
  // Algo se dijo: la reunión existe de verdad, con transcripción y todo.
  await fetch(`${API}/api/meet-bridge/${encodeURIComponent(sala)}/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speaker: "Ana", text: "esto quedó en la transcripción igual", lang: "es-AR" }),
  });

  // ── 1. El bot no pudo grabar: que la reunión lo diga ────────────────────
  console.log("\n── El bot no pudo grabar, y la reunión guardada lo dice ──");
  {
    const detalle = "El bot no pudo capturar la pantalla de la reunión, así que no hay video.";
    await fetch(`${API}/api/meet-bridge/${encodeURIComponent(sala)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origen: "bot", inCall: true, botGrabacion: "fallo", botGrabacionDetalle: detalle }),
    });
    await new Promise((r) => setTimeout(r, 1500));

    const d = await fetch(`${API}/api/meetings/${dbId}`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    const m = d.meeting ?? d;
    check("la reunión NO tiene grabación (era lo esperado)", !m.recordingUrl, String(m.recordingUrl));
    // Lo que importa: el motivo sobrevivió al Map en memoria y quedó en la
    // fila. Un reinicio del servidor ya no se lo lleva.
    check("PERO SÍ trae escrito por qué no la tiene", typeof m.recordingNote === "string" && m.recordingNote.length > 0,
      String(m.recordingNote));
    check("y el porqué es el que dio el bot, no uno inventado",
      /capturar la pantalla/i.test(m.recordingNote || ""), String(m.recordingNote).slice(0, 120));
  }

  // ── 2. En la PANTALLA del historial se lee ─────────────────────────────
  console.log("\n── Y se lee en la pantalla de la reunión guardada ──");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.route("**fonts.g**", (r) => r.abort());
  {
    // La sesión, como la deja el login (el servidor sale del build: la
    // batería compila con VITE_SERVER_URL=http://localhost:4001).
    await page.addInitScript((t) => localStorage.setItem("encuentro_token", t), reg.token);
    await page.goto(`${B}/historial/${dbId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const texto = await page.evaluate(() => document.body.innerText);
    check("la pantalla habla de la grabación (no la ignora)", /Grabaci[óo]n/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 160));
    check("y dice EL MOTIVO con todas las letras", /capturar la pantalla/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 200));
    // Que no se lleve puesta la transcripción: el aviso explica la falta de
    // video, no reemplaza lo que sí se guardó.
    check("y lo que sí se dijo sigue estando", /quedó en la transcripción igual/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 200));
  }

  // ── 3. Sin motivo guardado tampoco hay hueco mudo ──────────────────────
  console.log("\n── Una reunión sin motivo guardado tampoco queda muda ──");
  {
    const sala2 = `google-meet:www-${Date.now().toString(36).slice(-4)}-vvv`;
    const s2 = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(sala2)}/session`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    check("la reunión sin grabación ya se puede leer", Boolean(await esperarReunion(s2.dbId, reg.token)));
    await page.goto(`${B}/historial/${s2.dbId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const texto = await page.evaluate(() => document.body.innerText);
    check("igual aparece el apartado de la grabación", /Grabaci[óo]n/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 160));
    check("diciendo que no hay grabación guardada", /no tiene grabaci[óo]n guardada/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 200));
  }

  // ── 4. La puerta del motivo no acepta texto de cualquiera ──────────────
  console.log("\n── El motivo lo escribe el servidor, no quien golpee la puerta ──");
  {
    // Esta puerta es anónima a propósito (los invitados también graban). Si
    // aceptara texto libre, cualquiera que sepa el código de una reunión
    // podría escribir lo que quisiera en el historial de otra persona.
    const libre = await jsonp(`${API}/api/meetings/${dbId}/recording-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: "ENTRÁ A ESTE SITIO: http://malo.example" }),
    });
    check("un motivo inventado se rechaza", libre.status === 400, `HTTP ${libre.status}`);
    const d = await fetch(`${API}/api/meetings/${dbId}`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    check("y no dejó nada escrito en la reunión",
      !/malo\.example/i.test((d.meeting ?? d).recordingNote || ""),
      String((d.meeting ?? d).recordingNote).slice(0, 120));

    const bueno = await jsonp(`${API}/api/meetings/${dbId}/recording-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: "microfono-ocupado" }),
    });
    check("un motivo de la lista sí entra", bueno.status === 200, `HTTP ${bueno.status}`);
    const d2 = await fetch(`${API}/api/meetings/${dbId}`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    check("y el texto que queda es el del servidor",
      /una sola cosa a la vez/i.test((d2.meeting ?? d2).recordingNote || ""),
      String((d2.meeting ?? d2).recordingNote).slice(0, 140));
  }

  // ── 5. Sin almacenamiento configurado: se dice, no se calla ────────────
  console.log("\n── El servidor sin dónde guardar videos lo deja escrito ──");
  {
    // Este stack de pruebas no tiene R2, igual que el servidor del reporte:
    // la subida rebota con 503. Antes eso era el final del camino y la
    // reunión quedaba en blanco.
    const sala3 = `google-meet:qqq-${Date.now().toString(36).slice(-4)}-ppp`;
    const s3 = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(sala3)}/session`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    check("la reunión de la subida ya se puede leer", Boolean(await esperarReunion(s3.dbId, reg.token)));
    const sub = await jsonp(`${API}/api/meetings/${s3.dbId}/recording-upload?durationMs=9000`, {
      method: "POST",
      headers: { "Content-Type": "video/webm" },
      body: "x".repeat(64),
    });
    check("la subida rebota (el servidor no tiene almacenamiento)", sub.status === 503, `HTTP ${sub.status}`);
    await new Promise((r) => setTimeout(r, 1500));
    const d = await fetch(`${API}/api/meetings/${s3.dbId}`, {
      headers: { Authorization: `Bearer ${reg.token}` },
    }).then((r) => r.json());
    check("y la reunión queda diciendo que falta configurar el almacenamiento",
      /almacenamiento/i.test((d.meeting ?? d).recordingNote || ""),
      String((d.meeting ?? d).recordingNote).slice(0, 140));
    check("y aclara que la transcripción sí se guardó",
      /transcripci[óo]n/i.test((d.meeting ?? d).recordingNote || ""),
      String((d.meeting ?? d).recordingNote).slice(0, 140));
  }

  // ── 6. Cuando por fin hay video, el aviso se va ────────────────────────
  console.log("\n── Con el video guardado, el aviso viejo desaparece ──");
  {
    // Un intento que falló antes no puede quedar diciendo "no se grabó" al
    // lado de un reproductor que sí anda: sería peor que el silencio.
    const tras = enLaBase("adjuntar", dbId, "https://videos.example/una.webm");
    check("la grabación quedó colgada de la reunión", tras.recordingUrl === "https://videos.example/una.webm",
      String(tras.recordingUrl));
    check("y el aviso de «no se grabó» se borró solo", tras.recordingNote === null, String(tras.recordingNote));

    // Y ya no se puede volver a ensuciar: hay video, lo de antes no importa.
    const despues = enLaBase("anotar", dbId, "esto no tendría que pegarse");
    check("con video guardado, un aviso tardío ya no se pega",
      despues.recordingNote === null, String(despues.recordingNote));

    await page.goto(`${B}/historial/${dbId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const texto = await page.evaluate(() => document.body.innerText);
    check("y la pantalla ya no dice que no hay grabación",
      !/no tiene grabaci[óo]n guardada/i.test(texto) && !/capturar la pantalla/i.test(texto),
      texto.replace(/\s+/g, " ").slice(0, 200));
  }

  check("sin errores de JavaScript en todo el recorrido", errs.length === 0, errs[0] || "");

  await ctx.close();
  await browser.close();
  resumen();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
