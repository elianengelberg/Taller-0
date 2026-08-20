// La IA que VE el video + el karaoke por palabra, contra el stack real.
//
// Para la parte de IA no se llama a Anthropic de verdad (costaría plata y el
// test no debe depender de un tercero): se levanta un "Anthropic de mentira"
// que CAPTURA lo que el servidor le manda. Así lo que se prueba es nuestra
// plomería completa: que los fotogramas capturados por el navegador viajen
// como bloques de imagen, con la transcripción en el system prompt, y que los
// topes de cantidad y tamaño se apliquen de verdad.
//
// Esta suite maneja su PROPIO servidor (con ANTHROPIC_BASE_URL apuntando al
// stub): hay que correrla con el puerto 4001 LIBRE. Requiere Postgres en 5433
// y pruebas/serve_csp.js sirviendo el build en 4174.
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const API = "http://localhost:4001";
const B = "http://localhost:4174";
const ANTHROPIC_PORT = 4178;
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try { body = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body };
}
const json = (b, extra = {}) => ({
  method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(b),
});

(async () => {
  // ═══════ El Anthropic de mentira ═══════
  const llamadas = [];
  const anthropicStub = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      try { llamadas.push(JSON.parse(Buffer.concat(partes).toString())); } catch { llamadas.push(null); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub", type: "message", role: "assistant", model: "stub",
        content: [{ type: "text", text: "RESPUESTA-STUB: fotogramas recibidos." }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => anthropicStub.listen(ANTHROPIC_PORT, r));

  // ═══════ Nuestro servidor, apuntando al stub ═══════
  const server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: "/home/user/Taller-0/server",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://postgres@localhost:5433/unify",
      AUTH_SECRET: "clave-de-pruebas-local-larga-1234567890",
      PORT: "4001",
      CLIENT_ORIGIN: "http://localhost:4174",
      ANTHROPIC_API_KEY: "clave-stub",
      ANTHROPIC_BASE_URL: `http://localhost:${ANTHROPIC_PORT}`,
    },
    stdio: "ignore",
    // Grupo propio para poder matar npx Y tsx juntos al final (matar sólo
    // npx deja al tsx huérfano ocupando el puerto).
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ok = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
  }
  check("el servidor con IA-stub arranca", await fetch(`${API}/health`).then((r) => r.ok).catch(() => false));

  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  // Cuenta dueña + reunión con transcripción, armadas por los caminos reales:
  // el bridge crea la reunión companion y el claim se la da a la cuenta.
  const email = `videoia${Date.now()}${rnd(4)}@test.com`;
  const reg = await api("/api/auth/register", json({ email, password: "melon42Trueno", name: "Vera Video" }));
  const auth = { Authorization: `Bearer ${reg.body.token}` };
  // Con correo configurado el login exigiría verificar; el token del registro
  // ya alcanza para todo lo que hace esta suite.
  await pg.query("UPDATE users SET email_verified = TRUE WHERE email = $1", [email]);
  const zoomKey = `zoom:7${Date.now() % 1e9}7`;
  await api(`/api/meet-bridge/${encodeURIComponent(zoomKey)}/transcript`,
    json({ speaker: "Ana", text: "El presupuesto del tercer trimestre subió veinte por ciento", lang: "es-AR" }));
  await api(`/api/meet-bridge/${encodeURIComponent(zoomKey)}/transcript`,
    json({ speaker: "Bruno", text: "La lámina azul muestra la curva de ventas", lang: "es-AR" }));
  const ses = await api(`/api/meet-bridge/${encodeURIComponent(zoomKey)}/session`);
  const dbId = ses.body.dbId;
  const claim = await api(`/api/meetings/${dbId}/claim`, { method: "POST", headers: auth });
  check("la reunión queda en la cuenta (claim)", claim.status === 200, `HTTP ${claim.status}`);

  // Un JPEG diminuto de verdad (1x1) en base64.
  const JPEG =
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

  // ═══════ 1. La IA recibe los fotogramas de verdad ═══════
  console.log("\n── 1. Fotogramas hasta el modelo ──");
  {
    llamadas.length = 0;
    const frames = [{ atSec: 10, data: JPEG }, { atSec: 65, data: JPEG }, { atSec: 120, data: JPEG }];
    const r = await api(`/api/meetings/${dbId}/ask`, json({ question: "¿Qué se ve en la lámina?", frames }, auth));
    check("la pregunta con fotogramas responde 200", r.status === 200, `HTTP ${r.status} ${r.body.error ?? ""}`);
    check("y devuelve la respuesta del modelo", /RESPUESTA-STUB/.test(r.body.answer ?? ""), r.body.answer);
    const ll = llamadas[0];
    const bloques = Array.isArray(ll?.messages?.[0]?.content) ? ll.messages[0].content : [];
    const imgs = bloques.filter((b) => b.type === "image");
    check("el modelo recibió los 3 bloques de imagen", imgs.length === 3, `imágenes=${imgs.length}`);
    check("como JPEG base64", imgs.every((b) => b.source?.media_type === "image/jpeg" && b.source?.data === JPEG));
    check("cada uno anotado con su minuto (1:05 para el segundo)",
      bloques.some((b) => b.type === "text" && /Fotograma en 1:05/.test(b.text ?? "")));
    check("la pregunta viaja después de las imágenes",
      bloques[bloques.length - 1]?.type === "text" && /lámina/.test(bloques[bloques.length - 1].text ?? ""));
    check("y el system prompt sigue trayendo la transcripción",
      /presupuesto del tercer trimestre/.test(ll?.system ?? ""));
    check("con la regla de mirar los fotogramas", /fotogramas del video/i.test(ll?.system ?? ""));
  }

  // ═══════ 2. Los topes son de verdad ═══════
  console.log("\n── 2. Topes de cantidad y tamaño ──");
  {
    llamadas.length = 0;
    const veinte = Array.from({ length: 20 }, (_, i) => ({ atSec: i, data: JPEG }));
    const r = await api(`/api/meetings/${dbId}/ask`, json({ question: "¿Cuántos fotogramas ves?", frames: veinte }, auth));
    const bloques = Array.isArray(llamadas[0]?.messages?.[0]?.content) ? llamadas[0].messages[0].content : [];
    check("mandar 20 fotogramas no pasa de 8", r.status === 200 && bloques.filter((b) => b.type === "image").length === 8,
      `imágenes=${bloques.filter((b) => b.type === "image").length}`);

    llamadas.length = 0;
    const sucios = [
      { atSec: 1, data: "esto no es base64 !!!" },
      { atSec: -5, data: JPEG },
      { atSec: 2, data: "x".repeat(500_000) },
      { atSec: 3, data: JPEG },
    ];
    const r2 = await api(`/api/meetings/${dbId}/ask`, json({ question: "¿y ahora?", frames: sucios }, auth));
    const b2 = Array.isArray(llamadas[0]?.messages?.[0]?.content) ? llamadas[0].messages[0].content : [];
    check("los fotogramas malformados/gigantes se descartan y sobrevive el válido",
      r2.status === 200 && b2.filter((b) => b.type === "image").length === 1,
      `imágenes=${b2.filter((b) => b.type === "image").length}`);

    llamadas.length = 0;
    const r3 = await api(`/api/meetings/${dbId}/ask`, json({ question: "sin fotos" }, auth));
    check("sin fotogramas, el mensaje sigue siendo texto plano (nada raro cambió)",
      r3.status === 200 && typeof llamadas[0]?.messages?.[0]?.content === "string");

    // El parser grande es SOLO de esa ruta: un cuerpo gigante en otra sigue
    // rebotando en los 100 KB de siempre.
    const gigante = await api("/api/auth/login", json({ email, password: "x".repeat(400_000) }));
    check("el resto de la API mantiene su tope chico de cuerpo", gigante.status === 413, `HTTP ${gigante.status}`);
  }

  // ═══════ 3. En el navegador: karaoke por palabra + la IA mira el video ═══════
  console.log("\n── 3. El reproductor con karaoke ──");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));

  // Fixture: un webm real de ~6 s generado acá mismo (canvas animado con una
  // "lámina" de texto grande), guardado dentro de dist para que lo sirva el
  // MISMO origen (media-src 'self' de la CSP real lo exige). Nota: como todo
  // webm de MediaRecorder, declara duración Infinity -- exactamente el caso
  // que la captura de fotogramas tiene que saber manejar.
  {
    await page.goto(`${B}/`, { waitUntil: "domcontentloaded" });
    const b64 = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const g = canvas.getContext("2d");
      let t = 0;
      const iv = setInterval(() => {
        t += 1;
        g.fillStyle = "#0b3d91";
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = "#fff";
        g.font = "bold 44px sans-serif";
        g.fillText("LÁMINA AZUL", 150, 150);
        g.font = "28px sans-serif";
        g.fillText("ventas Q3 +" + (t % 60), 220, 230);
      }, 60);
      const stream = canvas.captureStream(20);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const fin = new Promise((r) => (recorder.onstop = r));
      recorder.start(500);
      await new Promise((r) => setTimeout(r, 6000));
      recorder.stop();
      await fin;
      clearInterval(iv);
      const blob = new Blob(chunks, { type: "video/webm" });
      const buf = await blob.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    });
    fs.mkdirSync("/home/user/Taller-0/client/dist/fixtures", { recursive: true });
    fs.writeFileSync("/home/user/Taller-0/client/dist/fixtures/clip.webm", Buffer.from(b64, "base64"));
    check("el video de prueba existe y pesa algo real",
      fs.statSync("/home/user/Taller-0/client/dist/fixtures/clip.webm").size > 30_000,
      `${fs.statSync("/home/user/Taller-0/client/dist/fixtures/clip.webm").size} bytes`);
  }

  // Reunión CON grabación: la del bridge de arriba, ahora con el video puesto
  // y tres líneas con tiempos conocidos (0s / 2s / 4s del video).
  {
    const inicio = new Date(Date.now() - 3600_000);
    await pg.query(
      `UPDATE meetings SET recording_url = $2, recording_started_at = $3, ended_at = now() WHERE id = $1`,
      [dbId, `${B}/fixtures/clip.webm`, inicio]
    );
    await pg.query(`DELETE FROM messages WHERE meeting_id = $1`, [dbId]);
    const linea = async (quien, texto, offsetSeg) => {
      await pg.query(
        `INSERT INTO messages (meeting_id, kind, sender_name, text, source_lang, created_at)
         VALUES ($1, 'transcript', $2, $3, 'es-AR', $4)`,
        [dbId, quien, texto, new Date(inicio.getTime() + offsetSeg * 1000)]
      );
    };
    await linea("Ana", "arrancamos con el presupuesto del tercer trimestre", 0);
    await linea("Bruno", "la lámina azul muestra la curva de ventas del equipo", 2);
    await linea("Carla", "cerramos con los pendientes de la semana que viene", 4);
  }

  await page.goto(`${B}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("encuentro_token", t), reg.body.token);
  await page.goto(`${B}/historial/${dbId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const cuerpo = await page.evaluate(() => document.body.innerText);
  check("la página de la reunión abre con su transcripción",
    cuerpo.includes("lámina azul") && cuerpo.includes("presupuesto"), cuerpo.slice(0, 60).replace(/\n/g, " "));
  check("el video está en la página", (await page.locator("video").count()) === 1);

  // ── Clic en una PALABRA del medio de la línea 2 → salta a su instante ──
  {
    // La línea 2 arranca en t=2 y termina en t=4 (la corta la línea 3).
    // "curva" es la palabra 6 de 9: t ≈ 2 + (5/9)*2 ≈ 3,1 s.
    const palabra = page.locator("p", { hasText: "lámina azul muestra" }).locator("span", { hasText: "curva" }).first();
    await palabra.click();
    await page.waitForTimeout(700);
    const t = await page.evaluate(() => document.querySelector("video").currentTime);
    check("tocar la palabra “curva” lleva al instante estimado en que se dijo (≈3,1 s)",
      t > 2.6 && t < 3.8, `currentTime=${t.toFixed(2)}`);
  }

  // ── Mientras el video avanza, la negrita va pasando por las palabras ──
  {
    await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 0; return v.play(); });
    await page.waitForTimeout(1200);
    const activas1 = await page.locator("li.border-brand-400 span.font-bold").count();
    const linea1 = await page.locator("li.border-brand-400").textContent().catch(() => "");
    check("a los ~1,2 s la línea 1 está activa con su palabra en negrita",
      activas1 >= 1 && /presupuesto/.test(linea1), linea1.slice(0, 60).replace(/\n/g, " "));
    await page.waitForTimeout(2000);
    const linea2 = await page.locator("li.border-brand-400").textContent().catch(() => "");
    check("a los ~3,2 s la negrita ya pasó a la línea 2 (sigue al video)",
      /lámina azul/.test(linea2), linea2.slice(0, 60).replace(/\n/g, " "));
    await page.evaluate(() => document.querySelector("video").pause());
  }

  // ── La IA del detalle MIRA el video: los fotogramas salen del reproductor ──
  {
    llamadas.length = 0;
    const t = await page.evaluate(() => document.body.innerText);
    check("la caja de IA avisa que también mira el video", /MIRA el video/i.test(t));
    await page.locator('input[placeholder*="pantalla"]').fill("¿Qué se mostró en pantalla?");
    await page.locator("form button[type=submit]", { hasText: "Preguntar" }).first().click()
      .catch(async () => { await page.keyboard.press("Enter"); });
    await page.waitForTimeout(9000);
    const r = await page.evaluate(() => document.body.innerText);
    check("la respuesta del modelo llega a la página", /RESPUESTA-STUB/.test(r));
    const ll = llamadas.find((l) => Array.isArray(l?.messages?.[0]?.content));
    const imgs = Array.isArray(ll?.messages?.[0]?.content)
      ? ll.messages[0].content.filter((b) => b.type === "image")
      : [];
    check("el navegador capturó fotogramas REALES del video y llegaron al modelo",
      imgs.length >= 4 && imgs.every((b) => (b.source?.data?.length ?? 0) > 1000),
      `imágenes=${imgs.length}`);
  }

  check("sin errores de JavaScript en la página", errs.length === 0, errs.slice(0, 2).join(" | "));

  await browser.close();
  await pg.end();
  try { process.kill(-server.pid); } catch { server.kill(); }
  anthropicStub.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
