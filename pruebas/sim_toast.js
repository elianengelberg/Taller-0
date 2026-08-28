// La extensión v4 REAL en Chromium real (bajo xvfb): detección de reuniones
// externas, el toast "Uy, veo que te estás uniendo…", el auto-SÍ a los 5
// segundos, la grabación del carril B (getDisplayMedia con la pestaña
// preseleccionada), el overlay en vivo y los subtítulos traducidos.
//
// La gracia del montaje: NO se toca el manifest. El navegador arranca con
// --host-resolver-rules para que *.zoom.us y meet.jit.si apunten a un
// servidor https local (certificado autofirmado + --ignore-certificate-errors),
// así los content_scripts se inyectan por los MISMOS matches que van a la
// Chrome Web Store. Un test que patea un manifest parchado no prueba el
// manifest.
//
// Requiere: el servidor real en 4001 (con base de datos). Correr con xvfb-run.
//
// Lo que NO se prueba acá y por qué: el carril A (tabCapture) necesita una
// invocación real del usuario (ícono/atajo) que Playwright no puede fabricar
// -- y su maquinaria (getMediaStreamId + offscreen) es la misma que Meet usa
// hace meses y cubre sim_realext.js.
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const EXT = path.resolve(__dirname, "../extension");
const API = "http://localhost:4001";
const STUB_PORT = 4177;
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

// Página de reunión falsa. El canvas animado importa: una pestaña estática
// casi no genera frames y la grabación quedaría por debajo del mínimo real
// de 20 KB que exige la extensión.
const PAGE = (titulo) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head>
<body style="margin:0;background:#111">
  <canvas id="c" width="640" height="360"></canvas>
  <script>
    const g = document.getElementById("c").getContext("2d");
    let t = 0;
    setInterval(() => {
      t += 1;
      g.fillStyle = "hsl(" + (t * 7 % 360) + ",70%,45%)";
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = "#fff"; g.font = "48px sans-serif";
      g.fillText("frame " + t, 40 + (t % 120), 180);
    }, 50);
  </script>
</body></html>`;

(async () => {
  // --- Certificado autofirmado + servidor https en 443 (somos root) --------
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "unify-cert-"));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${certDir}/k.pem -out ${certDir}/c.pem -days 2 -subj "/CN=zoom.us"`,
    { stdio: "ignore" }
  );
  const fakeSites = https.createServer(
    { key: fs.readFileSync(`${certDir}/k.pem`), cert: fs.readFileSync(`${certDir}/c.pem`) },
    (req, res) => {
      const host = String(req.headers.host || "");
      const titulo = host.includes("zoom") ? "Zoom falso" : host.includes("whereby") ? "Whereby falso" : "Jitsi falso";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE(titulo));
    }
  );
  await new Promise((r) => fakeSites.listen(443, r));

  // --- Stub de Unify para el camino feliz de la subida ----------------------
  // El servidor real no tiene R2 en este entorno (la subida da 503, y ESO
  // también se prueba, abajo). El stub guarda los bytes para poder afirmar
  // que lo subido es un webm de verdad, no un puñado de promesas.
  let subida = null;
  let subidas = 0; // cuántas subidas llegaron: el candado anti doble grabación se mide acá
  const stub = http.createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.url.includes("/api/meet-bridge/") && req.url.endsWith("/session")) {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ dbId: "stub-db-1", joinCode: "STUB", transcript: [], participants: [] }));
      return;
    }
    if (req.url === "/version-extension.json") {
      // La web publica la versión del ZIP en cada deploy; acá se finge una
      // futura para probar el aviso de "hay una versión nueva".
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "99.0.0" }));
      return;
    }
    if (req.url.startsWith("/api/meetings/stub-db-1/recording-upload")) {
      const partes = [];
      req.on("data", (c) => partes.push(c));
      req.on("end", () => {
        subida = { bytes: Buffer.concat(partes), url: req.url };
        subidas += 1;
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, url: "https://stub/video.webm" }));
      });
      return;
    }
    res.writeHead(404, cors);
    res.end("{}");
  });
  await new Promise((r) => stub.listen(STUB_PORT, r));

  // --- Chromium con la extensión real y el DNS mapeado -----------------------
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unify-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: false, // extensiones piden ventana; corre bajo xvfb
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      // El entorno define HTTPS_PROXY y Chromium lo hereda: el CONNECT al
      // proxy le gana a --host-resolver-rules y rompe el mapeo. Este
      // navegador sólo habla con localhost y dominios mapeados a localhost,
      // así que va directo.
      "--no-proxy-server",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--ignore-certificate-errors",
      '--host-resolver-rules=MAP *.zoom.us 127.0.0.1, MAP zoom.us 127.0.0.1, MAP meet.jit.si 127.0.0.1, MAP whereby.com 127.0.0.1, MAP *.webex.com 127.0.0.1, MAP global.gotomeeting.com 127.0.0.1, MAP bluejeans.com 127.0.0.1, MAP discord.com 127.0.0.1, MAP v.ringcentral.com 127.0.0.1, MAP app.chime.aws 127.0.0.1',
      // Acepta solo el pedido de captura de ESTA pestaña (preferCurrentTab),
      // que es exactamente lo que hace el carril B.
      "--auto-accept-this-tab-capture",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("la extensión v4 carga (service worker activo)", Boolean(sw), sw ? "ok" : "no arrancó");
  const extId = sw ? new URL(sw.url()).host : null;

  // serverBase -> stub, escrito donde lo escribe el popup de verdad.
  const setStorage = async (valores) => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.evaluate((v) => new Promise((r) => chrome.storage.local.set(v, r)), valores);
    await p.close();
  };
  await setStorage({ serverBase: `http://localhost:${STUB_PORT}` });

  // ═══════ 1. Detección y toast en una URL REAL de Zoom ═══════
  console.log("\n── 1. El toast en zoom.us ──");
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.goto("https://us05web.zoom.us/j/91234567890?pwd=x", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const toast = page.locator(".caja");
  check("el toast aparece con los matches del manifest PUBLICADO", (await toast.count()) === 1);
  const texto = await toast.textContent().catch(() => "");
  check("dice “Uy, veo que te estás uniendo…” y ofrece grabarla",
    /Uy, veo que te estás uniendo a una reunión de Zoom/.test(texto) && /¿Querés grabarla\?/.test(texto) && /subtítulos/.test(texto),
    texto.slice(0, 80));
  check("avisa la cuenta regresiva del auto-SÍ", /arranco solo/.test(texto));
  check("ofrece el atajo del carril A en el pie", /Ctrl\+Shift\+U/.test(texto));
  // En la página /j/ (la que abre la app de escritorio) ofrece el camino que
  // SÍ funciona: unirse desde el navegador (el cliente web /wc/join).
  check("en la página de lanzamiento de Zoom ofrece unirse desde el navegador",
    (await page.getByRole("button", { name: /Unirme desde el navegador/i }).count()) === 1);
  check("y avisa que la app de escritorio deja a Unify afuera", /app de escritorio/i.test(texto));

  // ═══════ 2. “Ahora no” se respeta (y le gana al timer) ═══════
  console.log("\n── 2. Ahora no ──");
  await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click();
  await page.waitForTimeout(400);
  check("el toast se va", (await page.locator(".caja").count()) === 0);
  await page.waitForTimeout(5500);
  check("y el auto-SÍ NO se dispara sobre un no explícito", (await page.locator(".caja").count()) === 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check("ni vuelve a molestar en la misma reunión tras recargar",
    (await page.locator(".caja").count()) === 0);

  // ═══════ 3. Sí, grabar (carril B) ═══════
  console.log("\n── 3. Sí, grabar (carril B) ──");
  await page.goto("https://us05web.zoom.us/j/98765432109", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check("nueva reunión, nuevo toast", (await page.locator(".caja").count()) === 1);

  await page.getByRole("button", { name: "Sí, dale" }).click();
  await page.waitForTimeout(2500);
  const overlay = await page.locator(".rec").textContent().catch(() => "");
  check("al aceptar, el overlay dice que está grabando y transcribiendo",
    /Grabando y transcribiendo/i.test(overlay), overlay.slice(0, 60));

  // Grabar unos segundos de canvas animado y detener desde el overlay.
  await page.waitForTimeout(7000);
  await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click(); // "Detener"
  await page.waitForTimeout(600);
  const guardando = await page.locator(".rec").textContent().catch(() => "");
  check("al detener, el overlay avisa que está guardando (no desaparece)",
    /guardando/i.test(guardando), guardando.slice(0, 50));
  await page.waitForTimeout(3000);
  const notaOk = await page.locator(".ok").textContent().catch(() => "");
  check("y confirma que quedó en el historial", /guardada/i.test(notaOk), notaOk.slice(0, 60));

  check("la grabación llegó al stub de Unify", Boolean(subida), subida ? `${subida.bytes.length} bytes` : "nada");
  if (subida) {
    check("con un tamaño real (no un archivo vacío)", subida.bytes.length > 20_000, `${subida.bytes.length} bytes`);
    const magia = subida.bytes.subarray(0, 4).toString("hex");
    check("y es un webm de verdad (magia EBML)", magia === "1a45dfa3", magia);
    check("la subida declara la duración", /durationMs=\d{3,}/.test(subida.url), subida.url.slice(0, 80));
  } else {
    check("con un tamaño real (no un archivo vacío)", false, "no hubo subida");
    check("y es un webm de verdad (magia EBML)", false, "no hubo subida");
    check("la subida declara la duración", false, "no hubo subida");
  }

  // ═══════ 4. Overlay + bridge real ═══════
  console.log("\n── 4. Overlay + bridge real ──");
  {
    await setStorage({ serverBase: API });

    const zoomId = `9${Date.now() % 1e9}0`;
    await page.goto(`https://acme.zoom.us/j/${zoomId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Sí, dale" }).click();
    await page.waitForTimeout(2000);

    // Alguien más (la web, otro overlay) publica una línea en la MISMA sala.
    const r = await fetch(`${API}/api/meet-bridge/${encodeURIComponent(`zoom:${zoomId}`)}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Bruno Web", text: "¿me escuchan desde el overlay?", lang: "es-AR" }),
    });
    check("el bridge real acepta la línea de esa sala", r.status === 200, `HTTP ${r.status}`);

    // El overlay sondea cada 2,5 s: a los 6 ya tiene que estar pintada.
    await page.waitForTimeout(6000);
    const subs = await page.locator(".subs").textContent().catch(() => "");
    check("el overlay la muestra EN VIVO con su hablante",
      subs.includes("Bruno Web") && subs.includes("¿me escuchan desde el overlay?"), subs.slice(0, 80));

    // Detener acá sube contra el servidor real SIN R2: el 503 tiene que
    // volver como un aviso honesto, no como un silencio.
    await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click();
    await page.waitForTimeout(3500);
    const aviso = await page.locator(".aviso").textContent().catch(() => "");
    check("sin almacenamiento configurado, la falla de subida SE DICE",
      /no pudimos subirla|no pudimos subir/i.test(aviso), aviso.slice(0, 80));
  }

  // ═══════ 5. Sin responder: a los 5 segundos arranca solo ═══════
  console.log("\n── 5. Sin responder: a los 5 segundos arranca solo ──");
  {
    // Idioma de traducción: inglés, como lo dejaría el panel de Meet.
    await setStorage({ lang: "en" });

    // La traducción del overlay es un fetch de la PÁGINA: se stubbea acá y se
    // afirma más abajo que el overlay la pinta (el proveedor real ya tiene su
    // propia cobertura en el servidor).
    await ctx.route("**/api/translate", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ translatedText: "EN: the blue slide shows the sales curve" }),
      })
    );

    const zoomId2 = `9${(Date.now() + 7) % 1e9}3`;
    await page.goto(`https://acme.zoom.us/j/${zoomId2}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    check("aparece el toast con la cuenta regresiva", (await page.locator(".caja").count()) === 1);

    // NO se toca nada: a los ~5 s tienen que arrancar los subtítulos solos.
    await page.waitForTimeout(6000);
    const estado = await page.locator(".rec").textContent().catch(() => "");
    check("a los 5 segundos, sin respuesta, los subtítulos arrancan SOLOS",
      /Subtítulos de Unify activos/i.test(estado), estado.slice(0, 60));
    check("con el selector de idioma en el idioma guardado",
      (await page.locator('select.sel[aria-label="Traducirme a"]').inputValue().catch(() => "")) === "en");
    check("y está el selector del idioma QUE SE HABLA (para reuniones en otro idioma)",
      (await page.locator('select.sel[aria-label="Idioma que se habla en la reunión"]').count()) === 1);
    check("y el botón Grabar a mano (la grabación en sí exige un gesto tuyo)",
      (await page.locator("button.si", { hasText: "Grabar" }).count()) === 1);

    // Usabilidad para todas las edades: MEDIDA, no prometida. Botones altos,
    // letra grande, botón secundario con borde visible y panel accesible.
    const alto = (await page.locator("button.si", { hasText: "Grabar" }).boundingBox())?.height ?? 0;
    check("los botones son grandes (>= 40px de alto)", alto >= 40, `alto=${alto}px`);
    const fuente = await page.locator(".caja").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check("la letra base del panel es legible (>= 15px)", fuente >= 15, `${fuente}px`);
    const borde = await page.locator("button.no").first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
    check("el botón secundario tiene borde visible (no es un texto gris perdido)", borde >= 1, `${borde}px`);
    const a11y = await page.locator(".caja").evaluate((el) => ({
      role: el.getAttribute("role"),
      vivo: el.querySelector(".subs")?.getAttribute("aria-live") ?? null,
    }));
    check("y se anuncia a los lectores de pantalla (dialog + subtítulos en vivo)",
      a11y.role === "dialog" && a11y.vivo === "polite", JSON.stringify(a11y));

    // Llega una línea a la sala (otro participante) -> el overlay la muestra
    // y la TRADUCE al idioma elegido.
    await fetch(`${API}/api/meet-bridge/${encodeURIComponent(`zoom:${zoomId2}`)}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Lin Wei", text: "la lámina azul muestra la curva de ventas", lang: "es-AR" }),
    });
    await page.waitForTimeout(6000);
    const subs2 = await page.locator(".subs").textContent().catch(() => "");
    check("el overlay muestra la línea original", /lámina azul/.test(subs2), subs2.slice(0, 70));
    check("y abajo su traducción al idioma elegido",
      /EN: the blue slide shows the sales curve/.test(subs2));

    // Un clic sobre NUESTRA UI (el pie del overlay, el selector) no es "el
    // próximo gesto en la página": no debe abrir el selector de pantalla ni
    // desarmar el pedido. (Bug real: elegir idioma disparaba la grabación.)
    await page.locator(".pie").click();
    await page.waitForTimeout(1500);
    const estadoUI = await page.locator(".rec").textContent().catch(() => "");
    check("un clic sobre el propio overlay NO dispara la grabación armada",
      /Subtítulos de Unify activos/i.test(estadoUI), estadoUI.slice(0, 60));

    // El próximo clic REAL en la página dispara la grabación armada
    // (--auto-accept-this-tab-capture confirma el selector por nosotros).
    await page.mouse.click(320, 180);
    await page.waitForTimeout(2500);
    const estado2 = await page.locator(".rec").textContent().catch(() => "");
    check("el primer clic en la página sí dispara la grabación que quedó armada",
      /Grabando y transcribiendo/i.test(estado2), estado2.slice(0, 60));
    await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click(); // Detener
    await page.waitForTimeout(2500);
  }

  // ═══════ 5b. Traducción automática: sin elección previa, sale el idioma del navegador ═══════
  console.log("\n── 5b. Traducción automática por defecto ──");
  {
    // Nunca eligió idioma: la clave NO existe en el storage (distinto de "",
    // que es "elegí Sin traducir" y se respeta).
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.evaluate(() => new Promise((r) => chrome.storage.local.remove("lang", r)));
    await p.close();

    const zoomId3 = `9${(Date.now() + 21) % 1e9}7`;
    await page.goto(`https://acme.zoom.us/j/${zoomId3}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9500); // toast + auto-SÍ
    const valor = await page.locator('select.sel[aria-label="Traducirme a"]').inputValue().catch(() => "(sin overlay)");
    // Este Chromium corre en inglés: la traducción tiene que arrancar sola en "en".
    check("sin elección previa, la traducción arranca sola en el idioma del navegador",
      valor === "en", `select=${valor}`);
  }

  // ═══════ 5c. La IA en el overlay ═══════
  console.log("\n── 5c. La IA dentro del overlay ──");
  {
    const pregunta = page.locator(".iain");
    check("el overlay trae el campo para preguntarle a la IA", (await pregunta.count()) === 1);

    // Sin sesión: la respuesta es una explicación honesta, no un error mudo.
    await pregunta.fill("¿De qué se habló?");
    await page.locator(".iabtn").click();
    await page.waitForTimeout(800);
    const sinSesion = await page.locator(".iaresp").textContent().catch(() => "");
    check("sin sesión de Unify, la IA lo DICE (no falla en silencio)",
      /Iniciá sesión/i.test(sinSesion), sinSesion.slice(0, 70));

    // Con sesión (el token llega por storage.onChanged, sin recargar) y el
    // endpoint del bridge stubbeado: la respuesta se pinta en el overlay.
    let authRecibida = null;
    await ctx.route("**/api/meet-bridge/**/ask", (route) => {
      authRecibida = route.request().headers()["authorization"] ?? null;
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ answer: "Se habló de la curva de ventas del trimestre." }),
      });
    });
    await setStorage({ token: "tok-prueba" });
    await page.waitForTimeout(600); // que onChanged propague el token
    await pregunta.fill("¿De qué se habló?");
    await page.locator(".iabtn").click();
    await page.waitForTimeout(1500);
    const conSesion = await page.locator(".iaresp").textContent().catch(() => "");
    check("con sesión, la respuesta de la IA se pinta en el overlay",
      /curva de ventas del trimestre/.test(conSesion), conSesion.slice(0, 70));
    check("y la pregunta viajó autenticada al endpoint del bridge",
      authRecibida === "Bearer tok-prueba", String(authRecibida));
    await ctx.unroute("**/api/meet-bridge/**/ask");
    await setStorage({ token: null });
  }

  // ═══════ 5d. Navegar ANTES de contestar mata la cuenta regresiva ═══════
  console.log("\n── 5d. La cuenta regresiva no sobrevive a la navegación ──");
  {
    // Zoom y Teams son SPAs: la URL cambia sin recargar y el content script
    // sigue vivo. Un timer huérfano dispararía el auto-SÍ de la reunión
    // ANTERIOR en una página que ya no es una reunión. (Bug real corregido.)
    const zoomId4 = `9${(Date.now() + 33) % 1e9}1`;
    await page.goto(`https://acme.zoom.us/j/${zoomId4}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    check("aparece el toast de la reunión", (await page.locator(".caja").count()) === 1);
    // A los ~2 s (antes del auto-SÍ) la SPA navega a una página que no es reunión.
    await page.evaluate(() => history.pushState({}, "", "/pricing"));
    await page.waitForTimeout(2500);
    check("al irse de la reunión, el toast se va con su cuenta regresiva",
      (await page.locator(".caja").count()) === 0);
    await page.waitForTimeout(5000);
    check("y el auto-SÍ viejo NO revive en una página que no es una reunión",
      (await page.locator(".caja").count()) === 0);
  }

  // ═══════ 5e. Dos clics rápidos NO abren dos grabaciones ═══════
  console.log("\n── 5e. El doble clic no duplica la grabación ──");
  {
    // Sin el candado, el segundo getDisplayMedia entrelazaría los chunks de
    // dos grabadores en el mismo puerto: un webm corrupto. Acá se hace el
    // doble clic sincrónico (el peor caso) y se afirma que llega UNA subida
    // y que sigue siendo un webm válido.
    await setStorage({ serverBase: `http://localhost:${STUB_PORT}` });
    const antes = subidas;
    const zoomId5 = `9${(Date.now() + 47) % 1e9}9`;
    await page.goto(`https://acme.zoom.us/j/${zoomId5}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.locator("button.si", { hasText: "Sí, dale" }).evaluate((b) => { b.click(); b.click(); });
    await page.waitForTimeout(2500);
    const estado5e = await page.locator(".rec").textContent().catch(() => "");
    check("con dos clics, hay UNA sola grabación en marcha",
      /Grabando y transcribiendo/i.test(estado5e), estado5e.slice(0, 50));
    await page.waitForTimeout(7000);
    await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click(); // Detener
    await page.waitForTimeout(3500);
    check("al detener llega exactamente UNA subida (no dos entrelazadas)",
      subidas - antes === 1, `subidas=${subidas - antes}`);
    const magia5e = subida ? subida.bytes.subarray(0, 4).toString("hex") : "sin subida";
    check("y es un webm válido (magia EBML)", magia5e === "1a45dfa3", magia5e);
    // La firma del bug del doble grabador: cada MediaRecorder abre su PROPIO
    // webm, así que un archivo con chunks de dos grabadores entrelazados trae
    // DOS encabezados EBML. Uno solo = una sola grabación de verdad.
    let encabezados = 0;
    if (subida) {
      const MAGIA = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
      for (let i = subida.bytes.indexOf(MAGIA); i !== -1; i = subida.bytes.indexOf(MAGIA, i + 1)) encabezados++;
    }
    check("con UN solo encabezado EBML (no hay segundo grabador escondido adentro)",
      encabezados === 1, `encabezados=${encabezados}`);
  }

  // ═══════ 5f. El recorrido REAL de un enlace de Zoom ═══════
  //
  // Te mandan un link de Zoom, lo abrís y caés en la página de lanzamiento
  // (/j/…). Si elegís "unirse desde el navegador", pasás al cliente web
  // (/wc/join/…): es una navegación completa y el content script arranca de
  // cero. Sin memoria de que ya aceptaste, te preguntaba LO MISMO otra vez a
  // los pocos segundos de haber dicho que sí.
  console.log("\n── 5f. Enlace de Zoom: lanzamiento → cliente web ──");
  {
    await setStorage({ serverBase: `http://localhost:${STUB_PORT}` });
    const id = `9${(Date.now() + 61) % 1e9}4`;
    await page.goto(`https://us05web.zoom.us/j/${id}?pwd=abc`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    check("al abrir el enlace, avisa en la página de lanzamiento",
      (await page.locator(".caja").count()) === 1);

    // Se acepta ahí, como haría cualquiera.
    await page.locator("button.si", { hasText: "Sí, dale" }).click();
    await page.waitForTimeout(2500);
    check("y arranca la grabación con ese clic",
      /Grabando y transcribiendo/i.test(await page.locator(".rec").textContent().catch(() => "")));
    await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click(); // Detener: la subida no es lo que se mide acá
    await page.waitForTimeout(2500);

    // "Unirse desde el navegador": misma reunión, otra página.
    await page.goto(`https://us05web.zoom.us/wc/join/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    check("al pasar al cliente web NO vuelve a preguntar lo mismo",
      (await page.locator("button.si", { hasText: "Sí, dale" }).count()) === 0);
    check("sigue de largo con los subtítulos, sin perder la reunión",
      /Subtítulos de Unify activos/i.test(await page.locator(".rec").textContent().catch(() => "")));
  }

  // ═══════ 6. Jitsi también (segunda plataforma, mismos matches) ═══════
  console.log("\n── 6. Jitsi ──");
  await page.goto("https://meet.jit.si/SalaDePruebaUnify", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const t2 = await page.locator(".caja").textContent().catch(() => "");
  check("el toast también sale en meet.jit.si", /reunión de Jitsi/.test(t2), t2.slice(0, 60));

  // ═══════ 7. Whereby (plataforma nueva, mismos matches del manifest) ═══════
  console.log("\n── 7. Whereby ──");
  await page.goto("https://whereby.com/sala-de-prueba-unify", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const t3 = await page.locator(".caja").textContent().catch(() => "");
  check("el toast también sale en whereby.com", /reunión de Whereby/.test(t3), t3.slice(0, 60));

  // ═══════ 7b. Webex y GoTo (el aviso sale en TODAS las plataformas del manifest) ═══════
  console.log("\n── 7b. Webex y GoTo ──");
  await page.goto("https://acme.webex.com/meet/juan.perez", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const t4 = await page.locator(".caja").textContent().catch(() => "");
  check("el toast también sale en webex.com", /reunión de Webex/.test(t4), t4.slice(0, 60));
  await page.goto("https://global.gotomeeting.com/join/123456789", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const t5 = await page.locator(".caja").textContent().catch(() => "");
  check("el toast también sale en gotomeeting.com", /reunión de GoTo Meeting/.test(t5), t5.slice(0, 60));

  // ═══════ 7c. El enlace puede llegar de CUALQUIER plataforma ═══════
  //
  // "Pensá que el link te lo pueden mandar de cualquier lado": la extensión
  // reconoce ahora todo lo que la web reconoce. Acá se abre una muestra en el
  // navegador real, con los matches del manifest que se publica.
  console.log("\n── 7c. Plataformas que llegan por un enlace suelto ──");
  for (const [url, nombre] of [
    ["https://bluejeans.com/123456789/1234", "BlueJeans"],
    ["https://discord.com/channels/123456/789012", "Discord"],
    ["https://v.ringcentral.com/join/1234567890", "RingCentral"],
    ["https://app.chime.aws/portal/1234567890?pin=9876", "Amazon Chime"],
  ]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const t = await page.locator(".caja").textContent().catch(() => "");
    check(`el aviso sale en ${nombre}`, new RegExp(`reunión de ${nombre}`).test(t), t.slice(0, 55));
    await page.getByRole("button", { name: /Detener|Cerrar|Ahora no/ }).first().click().catch(() => {}); // no encadenar toasts
  }

  // ═══════ 8. El aviso de "hay una versión nueva" ═══════
  console.log("\n── 8. Aviso de versión nueva ──");
  {
    // La web (acá, el stub) publica version-extension.json con una versión
    // futura. Entrar a una reunión dispara el chequeo (throttle reseteado) y
    // el popup tiene que ofrecer actualizar -- es la única campana de quien
    // instaló por ZIP, porque desde la tienda Chrome actualiza solo (y por eso
    // el aviso lleva ahí: para que sea la última vez que alguien instala algo).
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.evaluate(
      (base) => new Promise((r) => chrome.storage.local.set({ appBase: base, lastVersionCheck: 0 }, r)),
      `http://localhost:${STUB_PORT}`
    );
    await p.close();

    // El injector manda unify-external-info al detectar la reunión, y ahí el
    // background compara versiones contra la web.
    await page.goto("https://meet.jit.si/OtraSalaUnify", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(600);
    const guardada = await popup.evaluate(
      () => new Promise((r) => chrome.storage.local.get("updateAvailable", (v) => r(v.updateAvailable)))
    );
    check("el background detectó la versión nueva publicada en la web",
      guardada === "99.0.0", String(guardada));
    const update = popup.locator("#update");
    check("y el popup ofrece actualizar", (await update.count()) === 1);
    const href = (await update.getAttribute("href").catch(() => "")) || "";
    // Y no lleva a bajar OTRO ZIP: lleva a la ficha de la tienda. Bajar un ZIP
    // sería volver a instalar versiones a mano el mes que viene; instalarla
    // una vez desde la tienda hace que Chrome la actualice para siempre.
    check("apuntando a la ficha de la tienda (de ahí se actualiza sola)",
      /chromewebstore\.google\.com\/detail\/[a-p]{32}$/.test(href), href);
    await popup.close();
  }

  // ═══════ 8b. La extensión se anuncia en la web de Unify ═══════
  //
  // El contrato entre las dos piezas: el content script marca <html> y la web
  // lee esa marca para poder decir "la extensión está instalada en ESTE
  // navegador". Se prueba con la extensión REAL sobre el build REAL, porque
  // si el contrato se rompe, la página mentiría con total seguridad.
  console.log("\n── 8b. La extensión se anuncia en la web ──");
  {
    const web = await ctx.newPage();
    await web.goto("http://localhost:4174/instalar", { waitUntil: "domcontentloaded" });
    await web.waitForTimeout(3000);
    const marca = await web.evaluate(() => document.documentElement.dataset.unifyExtension ?? null);
    const manifiesto = JSON.parse(
      require("fs").readFileSync(path.resolve(__dirname, "../extension/manifest.json"), "utf8")
    );
    check("la extensión deja su versión en la página de Unify",
      marca === manifiesto.version, `marca=${marca} manifest=${manifiesto.version}`);
    const texto = await web.evaluate(() => document.body.innerText);
    check("y la web lo muestra como “está instalada en este navegador”",
      /está instalada en este navegador/i.test(texto) && texto.includes(manifiesto.version),
      texto.slice(0, 90).replace(/\n/g, " "));
    await web.close();
  }

  // ═══════ 9. Sobrevivir a la actualización de la extensión ═══════
  console.log("\n── 9. Cuando la extensión se actualiza sola ──");
  {
    // Es el caso que la auto-actualización volvió cotidiano: la extensión se
    // recarga y el content script de cada pestaña abierta queda huérfano. Ahí
    // chrome.runtime.sendMessage TIRA de forma síncrona, y sin protección el
    // aviso de reunión no volvía a aparecer nunca más en esa pestaña.
    // Se deja el overlay ABIERTO (auto-SÍ a los 5 s): es el estado en el que
    // una actualización realmente encuentra a la gente, en plena reunión.
    await page.goto("https://meet.jit.si/SalaAntesDeActualizar", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    check("antes de actualizar, el overlay está trabajando",
      /Subtítulos de Unify activos/i.test(await page.locator(".rec").textContent().catch(() => "")));

    // Recargar la extensión es exactamente lo que hace una actualización.
    await ctx.serviceWorkers()[0].evaluate(() => chrome.runtime.reload());
    await page.waitForTimeout(4000);

    // Hay que NAVEGAR para que el bug aparezca: tick() sale temprano si la
    // URL no cambió, y recién al cambiar llega a chrome.runtime.sendMessage
    // -- que en un contexto muerto tira de forma SÍNCRONA. Sin este paso, la
    // prueba pasaba por el motivo equivocado (nunca ejecutaba la línea
    // peligrosa), que es la clase de PASS que no vale nada.
    const antesDeNavegar = errs.length;
    await page.evaluate(() => history.pushState({}, "", "/OtraSalaTrasActualizar"));
    await page.waitForTimeout(3000);

    // ESTO es lo que se está probando: el content script huérfano no explota
    // y además avisa qué hacer, en vez de quedarse mudo para siempre.
    check("la pestaña huérfana NO tira el error de contexto invalidado (aun navegando)",
      errs.length === antesDeNavegar,
      errs.slice(antesDeNavegar, antesDeNavegar + 1).join(" | ") || "sin errores nuevos");
    const aviso9 = await page.locator(".aviso").textContent().catch(() => "");
    check("y le dice a la persona que recargue para seguir con la versión nueva",
      /se actualizó/i.test(aviso9) && /recarg/i.test(aviso9), aviso9.slice(0, 70));

    // Lo que NO se puede probar acá, dicho de frente: en este arnés
    // (Playwright + extensión descomprimida) chrome.runtime.reload() deja el
    // navegador SIN la extensión -- ctx.serviceWorkers() queda vacío y no se
    // reinyecta en ninguna pestaña. Chrome real la reinstala en el acto, así
    // que "la pestaña nueva anda con la versión nueva" es cierto pero no
    // demostrable desde este banco de pruebas: se imprime SKIP, no un PASS
    // regalado.
    console.log("SKIP tras la actualización, una pestaña nueva funciona sola — el arnés no reinstala la extensión (Chrome real sí)");
  }

  check("ninguna página tiró errores de JavaScript", errs.length === 0, errs.slice(0, 2).join(" | "));

  await ctx.close();
  fakeSites.close();
  stub.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
