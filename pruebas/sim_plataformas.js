// Las plataformas nuevas, de punta a punta: que se reconozcan, que ofrezcan lo
// correcto (embed real vs. Unify al lado), que entren a una sala compartida
// bien formada y que los subtítulos funcionen igual en todas.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const IGNORABLE = /fonts\.g|external_api|favicon|ERR_ABORTED|8x8|jit\.si|whereby|element\.io|zoom|teams|ResizeObserver|api\/(zoom\/signature|teams\/token)/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 130)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Recurso externo cortado por el sandbox (proxy 502/404): no es del producto.
    if (/Failed to load resource/i.test(m.text()) && !(m.location?.().url || "").includes("localhost")) return;
    const t = `${m.text()} ${m.location?.().url || ""}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 100)}`);
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  await ctx.route("**fonts.g**", (r) => r.abort());
  // Nada de red externa en el sandbox: los scripts e iframes de terceros se
  // cortan, que es justo el caso feo (y tiene que degradar, no romperse).
  await ctx.route("**external_api.js", (r) => r.abort());
  await ctx.route(/whereby\.com|element\.io|8x8\.vc|jitsi\./, (r) => r.abort());
  // addInitScript corre en TODOS los marcos, incluido el iframe de terceros
  // (que acá está bloqueado y queda en un origen opaco donde localStorage
  // lanza SecurityError). El try/catch es del test, no del producto.
  await ctx.addInitScript(() => {
    try { localStorage.setItem("unify_autorecord_externa", "0"); } catch {}
  });

  // ═════ 1. Reconocimiento y oferta correcta por plataforma ═════
  console.log("\n── 1. Reconocimiento ──");
  const page = await ctx.newPage();
  const bag = []; watch(page, bag);

  const cases = [
    // [etiqueta, enlace, nombre esperado, ¿ofrece unirse?]
    ["Jitsi 8x8 (JaaS)", "https://8x8.vc/vpaas-magic-cookie-abc/SalaEquipo", "Jitsi", true],
    ["Jitsi autohospedado", "https://jitsi.miempresa.com/Reunion2026", "Jitsi", true],
    ["Whereby", "https://acme.whereby.com/reunion-semanal", "Whereby", true],
    ["Element Call", "https://call.element.io/SalaAbierta", "Element Call", true],
    ["GoTo Meeting", "https://global.gotomeeting.com/join/123456789", "GoTo Meeting", true],
    ["BlueJeans", "https://bluejeans.com/123456789/1234", "BlueJeans", true],
    ["Amazon Chime", "https://app.chime.aws/meetings?pin=1234567890", "Amazon Chime", true],
    ["Slack huddle", "https://app.slack.com/huddle/T123/C456", "Slack", true],
    ["WhatsApp", "https://call.whatsapp.com/video/AbCdEfGh", "WhatsApp", true],
    ["Zoho Meeting", "https://meeting.zoho.com/meeting/join?key=abc123", "Zoho Meeting", true],
    ["Dialpad", "https://meetings.dialpad.com/room/diego", "Dialpad", true],
    ["RingCentral", "https://v.ringcentral.com/join/1234567890", "RingCentral", true],
    ["Livestorm", "https://app.livestorm.co/p/abc-def", "Livestorm", true],
    ["Gather", "https://app.gather.town/app/xyz/oficina", "Gather", true],
  ];

  for (const [label, link, expectName, joinable] of cases) {
    await page.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Enlace de la reunión").fill(link);
    await page.waitForTimeout(420);
    const body = (await page.locator("body").textContent()) || "";
    const offers = (await page.getByRole("button", { name: /Unirme/i }).count()) > 0;
    check(`${label}: se reconoce y ofrece unirse`,
      body.includes(expectName) && offers === joinable,
      `nombre=${body.includes(expectName)} unirse=${offers}`);
  }

  // Un enlace desconocido pero válido: se puede acompañar igual.
  await page.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill("https://videollamadas.miempresa.com/sala/ventas");
  await page.waitForTimeout(500);
  const unknownBody = (await page.locator("body").textContent()) || "";
  check("una plataforma que NO conocemos igual se puede acompañar",
    /No conocemos/i.test(unknownBody) &&
      (await page.getByRole("button", { name: /Unirme con Unify al lado/i }).count()) > 0,
    unknownBody.slice(0, 60).replace(/\s+/g, " "));

  // Un enlace sin ruta no identifica ninguna reunión: no se ofrece.
  await page.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill("https://www.ejemplo.com/");
  await page.waitForTimeout(500);
  check("un enlace sin sala NO se ofrece como reunión",
    (await page.getByRole("button", { name: /Unirme/i }).count()) === 0);

  check("reconocimiento sin errores", bag.length === 0, bag[0] || "");
  await page.close();

  // ═════ 2. Entrar de verdad en las nuevas ═════
  console.log("\n── 2. Entrar y ver subtítulos ──");
  for (const [label, link, expectPane] of [
    ["Whereby (embed por iframe)", `https://acme.whereby.com/sala${rnd(5)}`, "iframe"],
    ["Element Call (embed por iframe)", `https://call.element.io/Sala${rnd(5)}`, "iframe"],
    ["GoTo (Unify al lado)", `https://global.gotomeeting.com/join/${Math.floor(Math.random() * 1e9)}`, "companion"],
    ["Desconocida (Unify al lado)", `https://videollamadas.acme.com/sala/${rnd(6)}`, "companion"],
  ]) {
    const p = await ctx.newPage();
    const b2 = []; watch(p, b2);
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill(link);
    await p.getByLabel("Tu nombre").fill("Tester");
    await p.waitForTimeout(500);
    const btn = p.getByRole("button", { name: /Unirme/i }).first();
    if ((await btn.count()) === 0) { check(`${label}: entra`, false, "no ofrece unirse"); await p.close(); continue; }
    await btn.click();
    await p.waitForTimeout(3200);
    check(`${label}: entra a la reunión`, p.url().includes("/externa/reunion"), p.url());

    if (expectPane === "iframe") {
      check(`${label}: monta el iframe de la plataforma`, (await p.locator("iframe").count()) > 0);
      // El iframe está bloqueado en el sandbox: tiene que aparecer la salida.
      await p.waitForTimeout(7000);
      check(`${label}: si no carga, ofrece la salida a Unify al lado`,
        (await p.getByText(/No se ve la reunión acá dentro/i).count()) > 0);
    } else {
      check(`${label}: muestra la pantalla de subtítulos`,
        (await p.getByText(/subtítulos aparecen acá|Escuchando|Sin transcribir/i).count()) > 0);
    }
    check(`${label}: el dock de Unify está`, (await p.getByTitle(/Invitar a los demás/i).count()) > 0);
    check(`${label}: sin errores`, b2.length === 0, b2[0] || "");
    await p.close();
  }

  // ═════ 3. Sala compartida: mismo enlace = misma sala ═════
  console.log("\n── 3. La sala se comparte bien ──");
  {
    const room = `sala${rnd(6)}`;
    const a = await ctx.newPage(); const b3 = await ctx.newPage();
    for (const [pg, who, extra] of [[a, "Ana", ""], [b3, "Bruno", "?utm_source=mail&t=xyz"]]) {
      await pg.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
      await pg.getByLabel("Enlace de la reunión").fill(`https://meetings.dialpad.com/room/${room}${extra}`);
      await pg.getByLabel("Tu nombre").fill(who);
      await pg.waitForTimeout(500);
      await pg.getByRole("button", { name: /Unirme/i }).first().click();
      await pg.waitForTimeout(2600);
    }
    await sleep(1500);
    const txt = (await a.locator("body").textContent()) || "";
    check("dos personas con el mismo enlace (query distinto) comparten sala",
      /2 en Unify/.test(txt), txt.match(/\d+ en Unify/)?.[0] || "no comparten");
    await a.close(); await b3.close();
  }
  {
    // Y dos reuniones DISTINTAS de Chime no pueden caer juntas: su id vive en
    // el query, así que sin cuidarlo todas compartirían sala.
    const keys = [];
    for (const pin of ["1111111111", "2222222222"]) {
      const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
      const ack = await new Promise((res) => s.timeout(8000).emit("join-companion",
        { externalKey: `chime:app.chime.aws/meetings/${pin}`, name: "X", language: "es-AR" }, (e, r) => res(r)));
      keys.push(ack?.meeting?.id);
      s.disconnect();
    }
    check("dos reuniones distintas de Chime NO comparten sala", keys[0] !== keys[1], keys.join(" vs "));
  }

  // ═════ 4. Subtítulos y traducción funcionan igual en una plataforma nueva ═════
  console.log("\n── 4. Subtítulos en una plataforma nueva ──");
  {
    const room = `sala${rnd(6)}`;
    const key = `goto:global.gotomeeting.com/join/${room}`;
    const p = await ctx.newPage();
    const b4 = []; watch(p, b4);
    await p.route("**/api/translate", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "translated" }) }));
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill(`https://global.gotomeeting.com/join/${room}`);
    await p.getByLabel("Tu nombre").fill("Anfitrión");
    await p.waitForTimeout(500);
    await p.getByRole("button", { name: /Unirme/i }).first().click();
    await p.waitForTimeout(3000);

    const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
    await new Promise((res) => s.timeout(8000).emit("join-companion",
      { externalKey: key, name: "Ana", language: "es-AR" }, (e, r) => res(r)));
    s.emit("transcript-line", { alternatives: ["esto se dijo en una reunion de goto meeting"], lang: "es-AR" });
    await sleep(2600);
    const txt = (await p.locator("body").textContent()) || "";
    check("los subtítulos llegan en una plataforma nueva", txt.includes("Ana"), txt.slice(0, 60).replace(/\s+/g, " "));
    check("el asistente de IA está disponible",
      (await p.getByRole("button", { name: /Abrir el asistente de IA/i }).count()) > 0);
    check("sin errores en la plataforma nueva", b4.length === 0, b4[0] || "");
    s.disconnect();
    await p.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
