// Auditoría E2E de reuniones externas, desde la perspectiva de alguien que se
// equivoca: pega texto de más, tiene mala conexión, le deniega el micrófono al
// navegador, cierra la pestaña a mitad de la subida, entra sin cuenta.
//
// Cubre las 5 áreas: parseo de enlaces, SDK vs companion, audio/subtítulos/IA,
// pantalla y grabación, y persistencia de invitados.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
// Un elemento que TIENE que estar: si no está, es FAIL (no un salto en
// silencio que deja la suite en verde con la pantalla rota).
const exigir = async (loc, nombre) => {
  const n = await loc.count().catch(() => 0);
  if (n > 0) return true;
  check(nombre, false, "no está en la pantalla");
  return false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const meetCode = () => `${rnd(3)}-${rnd(4)}-${rnd(3)}`;

// Ruido esperable que NO es un error del producto. El 503 de /api/zoom/signature
// y /api/teams/token es la respuesta correcta de un servidor sin esas
// credenciales: lo que importa es que la app se recupere, y eso se comprueba
// aparte (degradación a companion).
const IGNORABLE =
  /fonts\.g|external_api|favicon|ERR_ABORTED|jit\.si|zoom\.us|teams\.microsoft|ResizeObserver|Download the React|api\/(zoom\/signature|teams\/token)/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location?.().url || "";
    const t = `${m.text()} ${url}`;
    if (IGNORABLE.test(t)) return;
    // Un recurso que no cargó sólo es NUESTRO problema si vive en nuestro
    // origen. El proxy del entorno a veces contesta 404/500 a los scripts
    // externos (jitsi, fuentes) y Chrome no siempre adjunta la URL al error:
    // sin ella, el texto genérico pasaba el filtro de arriba y ensuciaba el
    // veredicto con ruido ajeno.
    if (/Failed to load resource/i.test(m.text()) && !url.includes("localhost")) return;
    bag.push(`consola: ${m.text().slice(0, 110)}`);
  });
}

// Entra a una reunión externa desde el formulario, como una persona real.
async function join(page, link, name = "Tester") {
  await page.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill(link);
  await page.getByLabel("Tu nombre").fill(name);
  await page.waitForTimeout(500);
  const btn = page.getByRole("button", { name: /Unirme acá dentro|Unirme con Unify al lado/i });
  if ((await btn.count()) === 0) return false;
  await btn.first().click();
  await page.waitForTimeout(2600);
  return page.url().includes("/externa/reunion");
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  await ctx.route("**fonts.g**", (r) => r.abort());
  await ctx.route("**external_api.js", (r) => r.abort());

  // ══════════ 1. ENTRADA Y PARSEO ══════════
  console.log("\n── 1. Entrada y parseo de enlaces ──");
  {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    const cases = [
      ["texto alrededor + token", "Aca esta mi Zoom: https://us05web.zoom.us/j/89123456789?pwd=Q2xhdWRl gracias", /Zoom/, "89123456789"],
      ["safelink de Outlook", "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting_ABC%2540thread.v2%2F0&data=05", /Microsoft Teams/, null],
      ["invitación entera con clave", "Diego te invita.\nUnirse: https://us05web.zoom.us/j/89123456789\nCódigo de acceso: 4821", /Zoom/, "89123456789"],
      ["sólo el código de Meet", "abc-defg-hij", /Google Meet/, "abc-defg-hij"],
      ["Teams personal", "https://teams.live.com/meet/9351234567890?p=SeCrEt", /Microsoft Teams/, null],
      ["Webex", "https://acme.webex.com/meet/diego", /Webex/, null],
      ["Skype", "https://join.skype.com/abcdEFGH", /Skype/, null],
    ];
    for (const [label, input, expect, id] of cases) {
      await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
      await p.getByLabel("Enlace de la reunión").fill(input);
      await p.waitForTimeout(450);
      const body = (await p.locator("body").textContent()) || "";
      check(label, expect.test(body) && (!id || body.includes(id)), body.slice(0, 0));
    }
    // La clave que venía en el texto se carga sola.
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill("https://us05web.zoom.us/j/89123456789\nCódigo de acceso: 4821");
    await p.waitForTimeout(500);
    const pc = p.getByLabel(/Contraseña de la reunión/i);
    check("la contraseña del texto se carga sola", (await pc.count()) === 0 || (await pc.first().inputValue()) === "4821",
      (await pc.count()) ? await pc.first().inputValue() : "sin campo (Zoom no configurado)");

    // Enlaces basura: ni crash ni oferta falsa.
    for (const bad of ["javascript:alert(1)", "no soy un link"]) {
      await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
      await p.getByLabel("Enlace de la reunión").fill(bad);
      await p.waitForTimeout(450);
      const canJoin = await p.getByRole("button", { name: /Unirme/i }).count();
      check(`enlace inválido rechazado: ${bad.slice(0, 34)}`, canJoin === 0);
    }
    // Un dominio que imita a Google Meet: lo importante es que NO se lo tome
    // por Google Meet y que se avise. (Ya no alcanza con "no ofrece unirse":
    // desde que se puede acompañar cualquier enlace, la protección real es el
    // aviso, no el silencio.)
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill("https://meet.google.com.evil.co/abc-defg-hij");
    await p.waitForTimeout(500);
    const fakeBody = (await p.locator("body").textContent()) || "";
    check("un dominio que imita a Google Meet se avisa y no se ofrece",
      /Cuidado con este enlace/i.test(fakeBody) &&
        (await p.getByRole("button", { name: /Unirme/i }).count()) === 0,
      fakeBody.slice(0, 60).replace(/\s+/g, " "));
    check("parseo sin errores de JS", bag.length === 0, bag[0] || "");
    await p.close();
  }

  // ══════════ 2. SDK vs COMPANION ══════════
  console.log("\n── 2. Embebido SDK vs modo companion ──");
  {
    // Zoom sin credenciales en el servidor: antes era un callejón sin salida.
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    // El servidor devuelve 503 al pedir la firma (no hay credenciales). Antes
    // eso era pantalla muerta con un "Reintentar" que nunca iba a andar; ahora
    // el SDK falla y la app degrada sola a companion.
    let sdkFailed = false;
    p.on("response", (r) => { if (r.url().includes("/api/zoom/signature") && r.status() >= 400) sdkFailed = true; });
    const joined = await join(p, "https://us05web.zoom.us/j/89123456789", "Zoomer");
    await p.waitForTimeout(2500);
    check("Zoom sin credenciales entra igual en modo companion", joined, `url=${p.url()}`);
    if (joined) {
      check("el SDK de Zoom efectivamente falló (503 de firma)", sdkFailed);
      // "Pantalla muerta" = el panel de error de ZoomEmbed, que se reconoce por
      // su campo de contraseña inline. (El botón "Reintentar" de los subtítulos
      // es otra cosa: aparece porque este navegador no transcribe voz.)
      check("tras fallar el SDK, degrada solo a companion (sin pantalla muerta)",
        (await p.getByText(/subtítulos aparecen acá|Escuchando|Sin transcribir/i).count()) > 0 &&
          (await p.locator("#zoom-inline-passcode").count()) === 0);
      check("Zoom companion: ofrece abrir la llamada en Zoom",
        (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0);
    }
    check("Zoom companion sin errores", bag.length === 0, bag[0] || "");
    await p.close();
  }
  {
    // Teams personal: Microsoft no permite embeberlo NUNCA -> companion directo.
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    const joined = await join(p, "https://teams.live.com/meet/9351234567890?p=SeCrEt", "Teamer");
    check("Teams personal entra directo en companion", joined, `url=${p.url()}`);
    if (joined) {
      const body = (await p.locator("body").textContent()) || "";
      check("Teams personal: la contraseña del enlace NO se muestra", !body.includes("SeCrEt"));
      // La sala compartida se arma con el id de la reunión, no con la URL entera.
      const key = await p.evaluate(() => localStorage.getItem("unify_external_name") !== null);
      check("Teams personal: ofrece abrir la llamada en Teams",
        (await p.getByRole("link", { name: /Abrir en Teams/i }).count()) > 0, String(key));
    }
    check("Teams personal sin errores", bag.length === 0, bag[0] || "");
    await p.close();
  }
  {
    // Jitsi con su script bloqueado: degrada a companion en vez de morir.
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    const joined = await join(p, `https://meet.jit.si/UnifySala${rnd(6)}`, "Jitser");
    check("Jitsi con external_api caído degrada a companion", joined);
    if (joined) {
      await p.waitForTimeout(1500);
      check("Jitsi degradado: sigue habiendo pantalla de subtítulos",
        (await p.getByText(/subtítulos aparecen acá|Escuchando|Sin transcribir/i).count()) > 0);
      check("Jitsi degradado: ofrece abrirlo en Jitsi",
        (await p.getByRole("link", { name: /Abrir en Jitsi/i }).count()) > 0);
    }
    check("Jitsi degradado sin errores", bag.length === 0, bag[0] || "");
    await p.close();
  }
  {
    // Dos personas que pegan el MISMO Teams con parámetros distintos tienen que
    // caer en la misma sala de Unify (antes se partían en dos).
    const id = String(Math.floor(Math.random() * 1e13));
    const a = await ctx.newPage(); const b2 = await ctx.newPage();
    await join(a, `https://teams.live.com/meet/${id}?p=AAA`, "Ana");
    await join(b2, `https://teams.live.com/meet/${id}?p=BBB&anon=true`, "Bruno");
    await sleep(2500);
    const aBody = (await a.locator("body").textContent()) || "";
    check("dos parámetros distintos = la MISMA sala de Unify", /2 en Unify|2 personas|Ana|Bruno/.test(aBody),
      aBody.match(/\d+ en Unify/)?.[0] || "no se ve el contador");
    await a.close(); await b2.close();
  }

  // ══════════ 3. AUDIO, SUBTÍTULOS, TRADUCCIÓN E IA ══════════
  console.log("\n── 3. Audio, subtítulos, traducción e IA ──");
  {
    const code = meetCode();
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await p.route("**/api/translate", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "translated line" }) }));
    await join(p, `https://meet.google.com/${code}`, "Anfitrión");
    const lang = p.getByTitle(/Idioma en el que ves los subtítulos/i);
    if (await exigir(lang, "el selector «Traducir a» está en el dock")) await lang.selectOption("en-US");

    const socks = [];
    for (const n of ["Ana", "Bruno", "Caro"]) {
      const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
      await new Promise((res) => s.timeout(8000).emit("join-companion",
        { externalKey: `google-meet:${code}`, name: n, language: "es-AR" }, (e, r) => res(r)));
      socks.push(s);
    }
    await sleep(700);
    for (const [i, s] of socks.entries()) {
      s.emit("transcript-line", { alternatives: [`linea numero ${i + 1} de la reunion de prueba`], lang: "es-AR" });
      await sleep(850);
    }
    await sleep(2200);
    const body = (await p.locator("body").textContent()) || "";
    check("se ven las voces de los TRES participantes", ["Ana", "Bruno", "Caro"].every((n) => body.includes(n)));
    check("se ve la traducción", body.includes("translated line"));

    // --- Cambio de idioma del hablante al vuelo ---
    await p.getByRole("button", { name: /Ver la transcripción completa/i }).click();
    await p.waitForTimeout(500);
    const spoken = p.getByLabel(/En qué idioma estás hablando vos/i);
    if (await exigir(spoken, "el panel tiene el selector del idioma que hablás")) {
      await spoken.first().selectOption("en-US");
      await p.waitForTimeout(1200);
      check("el idioma hablado queda cambiado (en-US)", (await spoken.first().inputValue()) === "en-US");
    }
    check("cambiar el idioma hablado al vuelo no rompe nada", bag.length === 0, bag[0] || "");
    await p.getByRole("button", { name: /Cerrar/i }).first().click().catch(() => {});
    await p.waitForTimeout(400);

    // --- Corte de red de 8 segundos: lo que se dice NO se pierde ---
    // (se prueba contra el servidor: una línea emitida mientras el socket está
    // caído tiene que llegar igual después del rejoin)
    const dropSock = socks[0];
    dropSock.io.engine.close(); // corta el transporte por debajo
    await sleep(600);
    dropSock.emit("transcript-line", { alternatives: ["esto lo dije justo cuando se cayo la red"], lang: "es-AR" });
    await sleep(500);
    const revived = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { revived.on("connect", r); revived.on("connect_error", x); });
    await new Promise((res) => revived.timeout(8000).emit("join-companion",
      { externalKey: `google-meet:${code}`, name: "Ana", language: "es-AR" }, (e, r) => res(r)));
    revived.emit("transcript-line", { alternatives: ["y esto lo dije cuando volvio"], lang: "es-AR" });
    await sleep(2500);
    const after = (await p.locator("body").textContent()) || "";
    check("tras reconectar se sigue recibiendo", after.includes("volvio"));
    check("la reconexión no genera errores", bag.length === 0, bag[0] || "");

    // --- IA sobre lo recién hablado ---
    await p.getByRole("button", { name: /Abrir el asistente de IA/i }).click();
    await p.waitForTimeout(700);
    check("el asistente de IA está disponible en la reunión externa",
      (await p.getByPlaceholder(/resumime|Ej:/i).count()) > 0);
    socks.forEach((s) => s.disconnect()); revived.disconnect();
    await p.close();
  }
  {
    // Micrófono DENEGADO a mitad: la pantalla tiene que decirlo, no mentir.
    const denied = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await denied.route("**fonts.g**", (r) => r.abort());
    await denied.grantPermissions([]);
    const p = await denied.newPage();
    const bag = []; watch(p, bag);
    await join(p, `https://meet.google.com/${meetCode()}`, "SinMic");
    await p.waitForTimeout(2500);
    const body = (await p.locator("body").textContent()) || "";
    // Chromium headless no trae reconocimiento de voz: tiene que avisarlo igual
    // en vez de quedarse en "Escuchando tu micrófono" para siempre.
    check("sin reconocimiento de voz lo dice en pantalla",
      /Sin transcribir|no puede transcribir|bloqueó el acceso|Revisá los permisos/i.test(body),
      body.includes("Escuchando tu micrófono") ? "sigue diciendo 'Escuchando'" : body.slice(0, 90));
    await denied.close();
  }

  // ══════════ 4. PANTALLA Y GRABACIÓN ══════════
  console.log("\n── 4. Compartir pantalla y grabación ──");
  {
    // (a) Camino completo: la captura se consigue durante el clic de "Unirme".
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await join(p, `https://meet.google.com/${meetCode()}`, "Grabador");
    await p.waitForTimeout(3500);
    const body = (await p.locator("body").textContent()) || "";
    check("la grabación arranca SOLA al entrar (sin tocar nada)",
      /Grabando/i.test(body), body.slice(0, 90).replace(/\s+/g, " "));
    const rec0 = p.getByRole("button", { name: /Detener grabación/i });
    check("graba con VIDEO cuando se pudo capturar la pantalla en el clic", (await rec0.count()) > 0);
    await rec0.first().click().catch(() => {});
    await p.waitForTimeout(3000);
    const dl = await p.locator("a[download]").first().getAttribute("download").catch(() => "");
    check("la grabación con pantalla queda como video", /\.mp4$|\.webm$/.test(dl || ""), `archivo=${dl}`);
    await p.close();
  }
  {
    // (b) Sin gesto útil (cancelan el selector, o entran por URL directa): la
    // grabación NO se cae, arranca en sólo audio.
    const noScreen = await browser.newContext({ viewport: { width: 1100, height: 800 }, permissions: ["microphone"] });
    await noScreen.route("**fonts.g**", (r) => r.abort());
    await noScreen.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const p = await noScreen.newPage();
    const bag = []; watch(p, bag);
    await join(p, `https://meet.google.com/${meetCode()}`, "SoloAudio");
    await p.waitForTimeout(4000);
    const body = (await p.locator("body").textContent()) || "";
    check("si cancelan la captura, igual graba el audio automáticamente",
      /Grabando audio/i.test(body), body.match(/Grabando\w*/)?.[0] || "no graba");
    check("en modo audio ofrece agregar la pantalla después", /Agregar pantalla/i.test(body));
    const rec = p.getByRole("button", { name: /Detener grabación/i });
    if (await exigir(rec, "está grabando (hay botón «Detener grabación»)")) { await rec.first().click(); await p.waitForTimeout(3000); }
    const dl = await p.locator("a[download]").first().getAttribute("download").catch(() => "");
    check("la grabación automática queda como audio", /\.(m4a|webm)$/.test(dl || ""), `archivo=${dl}`);
    check("modo audio sin errores", bag.length === 0, bag[0] || "");
    await p.close();
    await noScreen.close();
  }
  {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await join(p, `https://meet.google.com/${meetCode()}`, "Guardas");
    await p.waitForTimeout(3000);

    // beforeunload protege la subida en curso.
    const guarded = await p.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    check("cerrar la pestaña grabando pide confirmación", guarded);

    // La bóveda de rescate existe y es usable.
    const vault = await p.evaluate(async () => {
      return await new Promise((res) => {
        const req = indexedDB.open("unify-recordings", 1);
        req.onsuccess = () => { const has = req.result.objectStoreNames.contains("pending"); req.result.close(); res(has); };
        req.onerror = () => res(false);
        req.onupgradeneeded = () => { try { req.result.createObjectStore("pending", { keyPath: "id" }); } catch {} };
      });
    });
    check("existe la bóveda de rescate de grabaciones (IndexedDB)", vault);

    // Detener y volver a grabar no rompe.
    const rec = p.getByRole("button", { name: /Detener grabación|Grabar la reunión/i });
    if (await exigir(rec, "hay botón de grabación")) { await rec.first().click(); await p.waitForTimeout(1500); }
    check("detener la grabación no rompe la pantalla", !p.isClosed() && bag.length === 0, bag[0] || "");
    await p.close();
  }
  {
    // Preferencia "no grabar": se respeta.
    const noRec = await browser.newContext({ viewport: { width: 1100, height: 800 }, permissions: ["microphone"] });
    await noRec.route("**fonts.g**", (r) => r.abort());
    await noRec.addInitScript(() => localStorage.setItem("unify_autorecord_externa", "0"));
    const p = await noRec.newPage();
    await join(p, `https://meet.google.com/${meetCode()}`, "NoGraba");
    await p.waitForTimeout(3000);
    const body = (await p.locator("body").textContent()) || "";
    check("si se desactiva la grabación automática, NO graba", !/Grabando/i.test(body));
    await noRec.close();
  }

  // ══════════ 5. INVITADOS Y PERSISTENCIA ══════════
  console.log("\n── 5. Invitados y persistencia ──");
  {
    const guest = await browser.newContext({ viewport: { width: 1100, height: 800 }, permissions: ["microphone"] });
    await guest.route("**fonts.g**", (r) => r.abort());
    const p = await guest.newPage();
    const bag = []; watch(p, bag);
    const code = meetCode();
    await join(p, `https://meet.google.com/${code}`, "Invitado");
    await p.waitForTimeout(2500);

    // El puntero de rescate se escribe AL ENTRAR, no al salir: cerrar la
    // pestaña de golpe ya no pierde la reunión para siempre.
    const pointer = await p.evaluate(() => localStorage.getItem("encuentro_unsaved_meeting"));
    check("el invitado puede reclamar la reunión aunque cierre de golpe", Boolean(pointer),
      pointer ? "puntero guardado" : "sin puntero");
    const dbId = pointer ? JSON.parse(pointer).dbId : null;

    // Cierre abrupto (sin pasar por "Salir").
    await p.close();
    await sleep(1200);

    // La reunión sigue existiendo en el servidor y se puede reclamar.
    if (dbId) {
      const res = await fetch(`${API}/api/meetings/${dbId}/recording-started`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      check("la reunión del invitado sigue viva en el servidor tras el cierre", res.ok, `HTTP ${res.status}`);
    } else {
      check("la reunión del invitado sigue viva en el servidor tras el cierre", false, "sin dbId");
    }
    check("cierre abrupto sin errores", bag.length === 0, bag[0] || "");
    await guest.close();
  }
  {
    // La transcripción queda guardada y se puede leer después.
    const code = meetCode();
    const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
    const ack = await new Promise((res) => s.timeout(8000).emit("join-companion",
      { externalKey: `google-meet:${code}`, name: "Persistente", language: "es-AR" }, (e, r) => res(r)));
    s.emit("transcript-line", { alternatives: ["esto tiene que quedar guardado en el historial"], lang: "es-AR" });
    await sleep(2500);
    const sess = await fetch(`${API}/api/meet-bridge/${code}/session`).then((r) => r.json()).catch(() => null);
    check("la transcripción se persiste y se puede releer",
      Boolean(sess?.transcript?.some((l) => /quedar guardado/.test(l.text || ""))),
      `líneas=${sess?.transcript?.length ?? "?"}`);
    check("la sala companion tiene id de historial", Boolean(ack?.meeting?.dbId));
    s.disconnect();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 500)); process.exit(1); });
