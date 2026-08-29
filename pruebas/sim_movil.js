// La app usada DESDE UN TELÉFONO: iPhone y Android emulados de verdad
// (pantalla táctil, viewport chico, user agent, densidad de píxeles).
//
// Lo que caza: overflow horizontal (la página que "baila" de costado),
// botones más chicos que un dedo, controles de la reunión que quedan abajo
// de la línea visible, y las funciones que en el teléfono NO existen
// (compartir pantalla en iPhone) rompiéndose en vez de explicarse.
const { chromium, devices } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io: sio } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IGNORABLE = /fonts\.g|favicon|ERR_ABORTED|ResizeObserver|Download the React|speech|recognition/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Recurso externo cortado por el sandbox (proxy 502/404): no es del producto.
    if (/Failed to load resource/i.test(m.text()) && !(m.location?.().url || "").includes("localhost")) return;
    const t = `${m.text()} ${m.location?.().url || ""}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 80)} @ ${(m.location?.().url || "").slice(-60)}`);
  });
}

// ¿La página se desborda de costado? (el bug móvil más común)
const desbordaX = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

// Botones tocables con un dedo: Apple pide 44px, Android 48; 40 es el piso
// que aceptamos para controles secundarios.
async function botonesChicos(p, minimo = 40) {
  return p.evaluate((min) => {
    const chicos = [];
    for (const b of document.querySelectorAll("button, a[href]")) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // oculto
      const texto = (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 25);
      // Los enlaces de texto corrido no son "botones" (un link inline en un
      // párrafo puede ser bajito); interesan los que actúan como botón.
      const esLink = b.tagName === "A" && !b.className.includes("btn") && !b.className.includes("rounded");
      if (esLink) continue;
      if (r.height < min || r.width < min) chicos.push(`${texto || b.tagName}(${Math.round(r.width)}x${Math.round(r.height)})`);
    }
    return chicos;
  }, minimo);
}

(async () => {
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const PERFILES = [
    ["iPhone 14", devices["iPhone 14"], true],
    ["Pixel 7", devices["Pixel 7"], false],
  ];

  for (const [nombre, device, esIphone] of PERFILES) {
    console.log(`\n════ ${nombre} ════`);
    const ctx = await browser.newContext({
      ...device,
      // El motor es Chromium igual (WebKit no está en este arnés): lo que se
      // prueba es el LAYOUT táctil y los caminos por user agent, que es lo
      // que la app decide mirar.
      permissions: ["microphone", "camera"],
    });
    // OJO: acá NO se bloquean las fuentes como en otras suites. Con el
    // service worker activo, abortar un pedido que su caché de runtime
    // intercepta deja la SEGUNDA navegación con el root vacío -- y todos los
    // checks de layout "pasan" sobre un cascarón. Costó encontrarlo.
    if (esIphone) {
      // En iPhone no existe getDisplayMedia: se borra ANTES de cargar la app
      // para probar el camino real de "compartir no disponible".
      await ctx.addInitScript(() => {
        try { delete MediaDevices.prototype.getDisplayMedia; } catch { /* readonly */ }
      });
    }
    const p = await ctx.newPage();
    const bag = [];
    watch(p, bag);

    // ── 1. Las pantallas públicas, a lo ancho de un teléfono ──
    for (const [ruta, etiqueta] of [["/", "inicio"], ["/ingresar", "ingresar"], ["/registrarse", "registro"], ["/unirse", "unirse"], ["/instalar", "instalar"]]) {
      await p.goto(`${B}${ruta}`, { waitUntil: "networkidle" });
      // Anti-cascarón: un root vacío haría "pasar" cualquier check de layout.
      const contenido = await p.evaluate(() => (document.getElementById("root")?.innerHTML ?? "").length);
      check(`${etiqueta}: la página tiene contenido real`, contenido > 500, `root=${contenido}`);
      check(`${etiqueta}: sin desborde horizontal`, !(await desbordaX(p)));
    }
    await p.waitForTimeout(800);
    check("instalar: le habla a ESTE aparato", await p.evaluate((esIos) => {
      const t = document.body.textContent ?? "";
      return esIos ? /iPhone|iPad/i.test(t) : /Android|Chrome/i.test(t);
    }, esIphone));

    // ── 2. Crear una reunión y usarla con el dedo ──
    const creator = sio(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { creator.on("connect", r); creator.on("connect_error", x); });
    const created = await new Promise((res) => creator.timeout(8000).emit("create-meeting",
      { hostName: "Semilla", hostLanguage: "es-AR", roles: [] }, (e, r) => res(e ? null : r)));
    const code = created?.meeting?.id;
    check("hay reunión para entrar", Boolean(code), String(code));
    creator.disconnect();

    await p.goto(`${B}/unirse/${code}`, { waitUntil: "domcontentloaded" });
    check("unirse con código: sin desborde", !(await desbordaX(p)));
    await p.getByLabel(/Tu nombre/i).fill("Movil");
    await p.waitForTimeout(300);
    await p.getByRole("button", { name: /Unirme|Entrar/i }).last().tap();
    await p.waitForTimeout(4500);
    check("entra a la reunión desde el teléfono", p.url().includes("/reunion"), p.url());
    check("la reunión no desborda de costado", !(await desbordaX(p)));

    // Los controles tienen que estar A LA VISTA, adentro del alto visible.
    const mic = p.getByRole("button", { name: /Silenciar micrófono|Activar micrófono/i }).first();
    const caja = await mic.boundingBox();
    const alto = device.viewport.height;
    check("la barra de controles queda dentro de la pantalla (nada cortado abajo)",
      Boolean(caja) && caja.y + caja.height <= alto + 1, caja ? `y=${Math.round(caja.y + caja.height)} de ${alto}` : "sin caja");

    const chicos = await botonesChicos(p);
    check("todos los controles alcanzan el tamaño de un dedo (≥40px)",
      chicos.length === 0, chicos.slice(0, 3).join(", "));

    // Tocar con el dedo funciona de verdad.
    await mic.tap();
    await p.waitForTimeout(600);
    check("silenciar con un toque anda",
      (await p.getByRole("button", { name: /Activar micrófono/i }).count()) > 0);
    await p.getByRole("button", { name: /Activar micrófono/i }).first().tap();
    await p.waitForTimeout(400);

    if (esIphone) {
      // En iPhone compartir pantalla NO existe (regla de Apple): el botón
      // tiene que EXPLICARLO, no abrir un selector roto ni tirar error.
      const compartir = p.getByRole("button", { name: /Compartir/i }).first();
      if (await compartir.count()) {
        await compartir.tap();
        await p.waitForTimeout(800);
        const texto = (await p.locator("body").textContent()) || "";
        check("compartir en iPhone se explica (no se rompe)",
          /no permite|no está disponible|no soporta|No se puede compartir/i.test(texto) || bag.length === 0,
          bag.slice(0, 1).join(""));
      }
    }
    check(`sin errores de JS en toda la sesión (${nombre})`, bag.length === 0, bag.slice(0, 3).join(" | "));

    // ── 2b. El "cartel" del teléfono: pegar el enlace con UN toque ──
    // En el teléfono no hay extensiones (regla de Google y Apple): el aviso
    // de "te estás uniendo" nace acá, del enlace copiado en WhatsApp.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: B });
    await p.goto(`${B}/`, { waitUntil: "networkidle" });
    await p.evaluate(() => navigator.clipboard.writeText("https://us05web.zoom.us/j/91234567890"));
    await p.getByRole("button", { name: /Pegar el enlace/i }).first().tap();
    await p.waitForTimeout(2000);
    check("un toque en «Pegar el enlace» lleva a la detección", p.url().includes("/externa"), p.url());
    check("y la reunión de Zoom queda detectada en el teléfono",
      /Zoom/i.test((await p.locator("body").textContent()) || ""));

    // ── 2c. El cartel AUTOMÁTICO: abrís la app con un enlace copiado ──
    // Con el permiso ya dado (quedó de 2b), abrir Unify mira el portapapeles
    // SOLO y ofrece la reunión sin tocar nada -- lo más cerca del aviso de la
    // extensión de PC que un teléfono permite.
    await p.goto(`${B}/`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1800);
    check("con permiso ya dado, el cartel aparece SOLO al abrir la app",
      /veo que copiaste un enlace de Zoom/i.test((await p.locator("body").textContent()) || ""));
    await p.getByRole("button", { name: /Ahora no/i }).first().tap();
    await p.waitForTimeout(400);
    await p.goto(`${B}/`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    check("«Ahora no» se recuerda: no insiste con el mismo enlace",
      !/veo que copiaste/i.test((await p.locator("body").textContent()) || ""));
    await p.evaluate(() => navigator.clipboard.writeText("https://meet.jit.si/SalaDePrueba"));
    await p.goto(`${B}/`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1800);
    check("un enlace NUEVO copiado vuelve a avisar (ahora Jitsi)",
      /enlace de Jitsi/i.test((await p.locator("body").textContent()) || ""));
    await p.getByRole("button", { name: /Entrar con subtítulos/i }).first().tap();
    await p.waitForTimeout(1500);
    check("«Entrar» lleva directo a la detección", p.url().includes("/externa"), p.url());

    // El cartel es GLOBAL: vive en cualquier pantalla de la app, y con la app
    // A LA VISTA (Split View del iPad, media pantalla en la compu) el sondeo
    // lo hace saltar al instante, sin navegar ni tocar nada.
    await p.goto(`${B}/soporte`, { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    await p.evaluate(() => navigator.clipboard.writeText("https://meet.google.com/abc-defg-hij"));
    await p.waitForTimeout(4500);
    check("copiar con la app a la vista hace saltar el cartel SOLO (en /soporte)",
      /enlace de Google Meet/i.test((await p.locator("body").textContent()) || "") && p.url().includes("/soporte"));
    await p.getByRole("button", { name: /Ahora no/i }).first().tap();

    // ── 3. Un enlace externo compartido AL teléfono ──
    await p.goto(`${B}/externa?url=${encodeURIComponent("https://us05web.zoom.us/j/91234567890")}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1500);
    const cuerpoExt = (await p.locator("body").textContent()) || "";
    check("un enlace de Zoom llegado al teléfono ofrece Unify al lado",
      /Zoom/i.test(cuerpoExt) && /Unify/i.test(cuerpoExt));
    check("y esa pantalla tampoco desborda", !(await desbordaX(p)));

    // ── 4. Subtítulos flotantes en el teléfono (PiP de VIDEO) ──
    // Sin documentPictureInPicture (Safari y Chrome móvil no lo tienen), el
    // botón flota un video dibujado desde un canvas: queda encima de la app
    // de Meet. El PiP real no existe en el arnés: se registra el pedido.
    const pf = await ctx.newPage();
    await pf.addInitScript(() => {
      try { delete window.documentPictureInPicture; } catch { /* no estaba */ }
      window.__pipVideo = 0;
      HTMLVideoElement.prototype.requestPictureInPicture = function () {
        window.__pipVideo++;
        return Promise.resolve({});
      };
      Object.defineProperty(document, "pictureInPictureEnabled", { get: () => true, configurable: true });
      window.open = () => null;
    });
    const bagF = [];
    watch(pf, bagF);
    await pf.goto(`${B}/externa?url=${encodeURIComponent("https://meet.google.com/flo-tant-esx")}`, { waitUntil: "networkidle" });
    await pf.waitForTimeout(800);
    const nombreF = pf.getByLabel("Tu nombre");
    if (await nombreF.count()) await nombreF.first().fill("Flota");
    if (!(await pf.getByRole("button", { name: /Unirme acá dentro/i }).count())) {
      const det = pf.getByRole("button", { name: /^Detectar$/ });
      if (await det.count()) await det.first().tap();
      await pf.waitForTimeout(500);
    }
    await pf.getByRole("button", { name: /Unirme acá dentro/i }).first().tap();
    await pf.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    const botonFlot = pf.getByRole("button", { name: /Subtítulos flotantes/i });
    check("el botón de subtítulos flotantes está en el teléfono", (await botonFlot.count()) > 0);
    if (await botonFlot.count()) {
      await botonFlot.first().tap();
      await pf.waitForTimeout(1200);
      check("tocarlo flota el video con los subtítulos (PiP de video)",
        await pf.evaluate(() => window.__pipVideo === 1),
        `pedidos=${await pf.evaluate(() => window.__pipVideo)}`);
      check("y el botón queda como activo",
        (await pf.getByRole("button", { name: /Flotantes ✓/i }).count()) > 0);
      check("el video flotante vive y transmite el canvas",
        await pf.evaluate(() => [...document.querySelectorAll("video")].some(
          (v) => v.muted && v.srcObject && v.srcObject.getVideoTracks?.().some((t) => t.readyState === "live"))));
      await pf.getByRole("button", { name: /Flotantes ✓/i }).first().tap();
      await pf.waitForTimeout(400);
      check("tocarlo de nuevo lo apaga y limpia el video",
        (await pf.getByRole("button", { name: /Subtítulos flotantes/i }).count()) > 0 &&
        await pf.evaluate(() => ![...document.querySelectorAll("video")].some((v) => v.muted && v.srcObject)));
    }
    check("sin errores de JS en el camino de flotantes", bagF.length === 0, bagF[0] || "");
    await pf.close();

    // ── 4b. EL MICRÓFONO ES DE UNO SOLO (iPhone/iPad) ──
    // En iOS el sistema le da la captura de audio a UNA cosa a la vez.
    // Grabar el micrófono y transcribirlo al mismo tiempo no da error: los
    // deja mudos a los dos. Eso dejaba la pantalla con "Escuchando tu
    // micrófono" y "Grabando audio" juntos, cero subtítulos, y una grabación
    // vacía que nunca llegaba al historial. La regla: mandan los subtítulos,
    // la grabación por micrófono NO arranca sola, y se ofrece el bot (que
    // graba desde el servidor, sin depender de este micrófono).
    if (esIphone) {
      // El bloque del portapapeles (más arriba) reemplaza los permisos de este
      // origen y deja el micrófono DENEGADO. Se lo devolvemos: si no, esta
      // sección probaría un teléfono sin micrófono -- y "no grabó sola" daría
      // verde por el motivo equivocado.
      await ctx.grantPermissions(["microphone", "camera", "clipboard-read", "clipboard-write"], { origin: B });
      const pm = await ctx.newPage();
      // Safari de iPhone SÍ tiene reconocimiento de voz; el Chromium del
      // arnés no. Se simula para probar el caso real del iPhone.
      await pm.addInitScript(() => {
        window.webkitSpeechRecognition = class {
          start() {}
          stop() {}
          abort() {}
        };
        window.open = () => null;
      });
      await pm.goto(`${B}/externa?url=${encodeURIComponent("https://meet.google.com/mic-unic-oxx")}`, { waitUntil: "networkidle" });
      await pm.waitForTimeout(800);
      const nombreM = pm.getByLabel("Tu nombre");
      if (await nombreM.count()) await nombreM.first().fill("Unico");
      // Con el nombre ya recordado de una pantalla anterior, la app puede
      // entrar sola desde el enlace: sólo se toca el botón si está.
      const unirmeM = pm.getByRole("button", { name: /Unirme acá dentro/i });
      if (!/\/externa\/reunion/.test(pm.url())) {
        await unirmeM.first().waitFor({ state: "visible", timeout: 15000 }).catch(async () => {
          const det = pm.getByRole("button", { name: /^Detectar$/ });
          if (await det.count()) await det.first().tap();
          await unirmeM.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
        });
        if (await unirmeM.count()) await unirmeM.first().tap();
      }
      await pm.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
      await pm.waitForTimeout(3000);
      const cuerpoMic = (await pm.locator("body").textContent()) || "";
      check("en iPhone la grabación NO le roba el micrófono a los subtítulos",
        !/Grabando audio/i.test(cuerpoMic), cuerpoMic.slice(0, 80).replace(/\n/g, " "));
      check("y la pantalla explica por qué la grabación está en pausa",
        /una sola cosa a la vez/i.test(cuerpoMic));
      check("y ofrece el bot ahí mismo, que graba sin usar este micrófono",
        /entre el bot por mí|mandar el bot/i.test(cuerpoMic));

      // Y si igual quiere grabar el audio: el traspaso del micrófono. Los
      // subtítulos lo SUELTAN primero y recién ahí graba (pedirlo de una era
      // el mismo choque: ni subtítulos ni grabación).
      const grabar = pm.getByRole("button", { name: /Grabar el audio por el micrófono/i });
      check("en iPhone el botón ofrece grabar el AUDIO (no una pantalla que no existe)",
        (await grabar.count()) > 0);
      if (await grabar.count()) {
        await grabar.first().tap();
        await pm.waitForTimeout(3000);
        const grabando = (await pm.locator("body").textContent()) || "";
        check("tocarlo SÍ graba (el traspaso del micrófono funciona)",
          /Grabando audio/i.test(grabando), grabando.slice(0, 70).replace(/\n/g, " "));
        check("y mientras graba, la pantalla dice que los subtítulos están en pausa",
          /subtítulos están en pausa/i.test(grabando));
        // Y al detenerla, los subtítulos vuelven solos.
        const detener = pm.getByRole("button", { name: /Detener grabación/i });
        if (await detener.count()) {
          await detener.first().tap();
          await pm.waitForTimeout(2500);
          const luego = (await pm.locator("body").textContent()) || "";
          check("al detenerla, los subtítulos vuelven solos",
            !/subtítulos están en pausa/i.test(luego));
        }
      }
      await pm.close();
    }

    // ── 5. La app instalada (pantalla de inicio de iOS) no abre la sábana ──
    // En la PWA de iOS, window.open abre un navegador interno ENCIMA de
    // Unify: si la app de Meet se lleva el enlace, esa sábana queda en
    // blanco tapando todo y no se puede cerrar desde el código. Ahí se
    // navega DIRECTO (iOS abre la app sin sábana y Unify queda abajo).
    //
    // Contexto propio SIN service worker: con una ruta interceptada, el SW
    // deja la página como cascarón vacío (limitación documentada de
    // Playwright: rutas + service workers piden serviceWorkers:"block").
    const ctxPwa = await browser.newContext({
      ...device,
      permissions: ["microphone", "camera"],
      serviceWorkers: "block",
    });
    const pw = await ctxPwa.newPage();
    await pw.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { get: () => true, configurable: true });
      window.__abiertos = [];
      window.open = (u) => { window.__abiertos.push(String(u)); return null; };
    });
    // El 204 simula el enlace universal de iOS: la navegación se pide pero
    // no comete y la página queda intacta (abort() la mandaría a
    // chrome-error:// y mataría la SPA, cosa que en el iPad real no pasa).
    let navegoAMeet = false;
    await pw.route("**meet.google.com/**", (r) => { navegoAMeet = true; r.fulfill({ status: 204 }); });
    // Sin el SW no hay caché de fuentes: las de Google cuelgan en el proxy
    // del arnés y "networkidle" no llega nunca. Se bloquean y listo.
    await pw.route("**fonts.g**", (r) => r.abort());
    await pw.goto(`${B}/externa?url=${encodeURIComponent("https://meet.google.com/pwa-inst-ala")}`, { waitUntil: "domcontentloaded" });
    await pw.waitForTimeout(1500);
    // Con el nombre ya recordado de antes, la app se une SOLA (el camino
    // automático); con el contexto limpio queda el formulario. Ambos valen:
    // lo que se mira es CÓMO se abrió la reunión real.
    if (!pw.url().includes("/externa/reunion")) {
      const nombreW = pw.getByLabel("Tu nombre");
      if (await nombreW.count()) await nombreW.first().fill("Pwa");
      if (!(await pw.getByRole("button", { name: /Unirme acá dentro/i }).count())) {
        const detW = pw.getByRole("button", { name: /^Detectar$/ });
        if (await detW.count()) await detW.first().tap();
        await pw.waitForTimeout(500);
      }
      // Sin auto-grabación: en este contexto el selector de pantalla del
      // arnés (getDisplayMedia sin fake-ui) colgaría el flujo de unión.
      const grabW = pw.getByRole("checkbox").first();
      if ((await grabW.count()) && (await grabW.isChecked().catch(() => false))) {
        await grabW.uncheck().catch(() => {});
      }
      await pw.getByRole("button", { name: /Unirme acá dentro/i }).first().tap();
      await pw.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    }
    // La navegación directa abortada por la ruta tarda un momento en morir:
    // sin esta espera, el evaluate cae justo en el medio.
    await pw.waitForTimeout(1500);
    const abiertosPwa = await pw.evaluate(() => (window.__abiertos || []).length).catch(() => -1);
    check("la app instalada navega DIRECTO a la reunión (cero ventanas internas)",
      navegoAMeet && abiertosPwa === 0, `navego=${navegoAMeet} abiertos=${abiertosPwa}`);
    check("y Unify sigue en su capa de subtítulos", pw.url().includes("/externa/reunion"));
    await ctxPwa.close();

    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
