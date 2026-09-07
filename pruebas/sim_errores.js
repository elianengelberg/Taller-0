// Cacería de errores en reuniones externas: recorre el flujo completo de cada
// plataforma y registra TODO lo que se rompa -- errores de JavaScript, errores
// de consola, pedidos de red fallidos y estados colgados.
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

// Ruido esperable que NO es un error del producto.
const IGNORABLE = /fonts\.g|external_api|favicon|ERR_ABORTED|net::ERR_FAILED.*(jit\.si|zoom|teams)|Failed to load resource.*(jit\.si|zoom|teams)|ResizeObserver/i;

function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // El texto de un fallo de red no incluye la URL: viene en location().
    const url = m.location?.().url || "";
    const t = `${m.text()} ${url}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 110)} @ ${url.slice(0, 80)}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (IGNORABLE.test(u)) return;
    if (u.startsWith(API) || u.startsWith(B)) bag.push(`red: ${r.failure()?.errorText} ${u.slice(0, 90)}`);
  });
}

async function joinExternal(page, link, name = "Tester") {
  await page.goto(`${B}/externa?link=${encodeURIComponent(link)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  // Con el nombre ya recordado, Unify entra sola (flujo de un clic desde la
  // extensión). Si ya estamos adentro, no hay formulario que completar.
  if ((await page.evaluate(() => location.pathname)).includes("/externa/reunion")) {
    await page.waitForTimeout(1600);
    return true;
  }
  const nameField = page.getByLabel("Tu nombre");
  if ((await nameField.count()) === 0) return false;
  await nameField.fill(name);
  const btn = page.getByRole("button", { name: /Unirme acá dentro/i });
  if ((await btn.count()) === 0) return false; // plataforma sin credenciales: correcto
  await btn.click();
  await page.waitForTimeout(2600);
  return true;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });

  // ================= 1. Recorrido completo por plataforma =================
  const platforms = [
    ["Google Meet", `https://meet.google.com/${meetCode()}`],
    ["Jitsi", `https://meet.jit.si/UnifySala${rnd(6)}`],
    ["Teams", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"],
  ];
  for (const [label, link] of platforms) {
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.route("**external_api.js", (r) => r.abort()); // sin red externa en el sandbox

    const joined = await joinExternal(page, link);
    if (!joined) {
      // Sin credenciales en el servidor no se ofrece unirse: es lo correcto.
      check(`${label}: sin credenciales avisa en vez de romperse`,
        (await page.getByText(/no tiene configuradas las credenciales|Abrir en/i).count()) > 0);
      check(`${label}: sin errores en ese camino`, bag.length === 0, bag.slice(0, 2).join(" | "));
      await page.close();
      continue;
    }
    check(`${label}: entra sin romperse (en la reunión y con la capa conectada)`,
      page.url().includes("/externa/reunion") &&
        /Companion activo/.test((await page.locator("body").textContent()) || ""),
      page.url());

    if (joined) {
      // Recorrer TODOS los paneles y controles, que es donde suele romperse.
      for (const nombre of [/Ver la transcripción completa/i, /Asignar roles/i, /Abrir el asistente de IA/i]) {
        const b = page.getByRole("button", { name: nombre });
        if (await b.count()) { await b.first().click(); await page.waitForTimeout(500); }
      }
      // Subtítulos on/off e idioma
      const cap = page.getByRole("button", { name: /subtítulos/i });
      if (await cap.count()) { await cap.first().click(); await page.waitForTimeout(300); await cap.first().click(); }
      const lang = page.getByTitle(/Idioma en el que ves los subtítulos/i);
      if (await lang.count()) { await lang.selectOption("en-US"); await page.waitForTimeout(400); }
      // Abrir/cerrar la invitación
      const inv = page.getByTitle(/Invitar a los demás/i);
      if (await inv.count()) { await inv.click(); await page.waitForTimeout(400); await inv.click(); }
      await page.waitForTimeout(600);
      check(`${label}: sin errores al usar todos los paneles`, bag.length === 0, bag.slice(0, 2).join(" | "));
    }
    await page.close();
  }

  // ================= 1b. Entrada de un clic (nombre recordado) =================
  // Con el nombre ya guardado (después del bloque 1), /externa?link=… entra
  // sola a la reunión. La pantalla se monta MILISEGUNDOS después del
  // proveedor, con el handshake del socket todavía en el aire, y un segundo
  // `socket.connect()` mandaba OTRO paquete CONNECT: el servidor cortaba y la
  // capa quedaba en «Reconectando…» para siempre (3 de 4 veces acá; en
  // producción, con más latencia, casi siempre). Se repite varias veces
  // porque es una carrera.
  {
    let conectadas = 0, connectsEnLaPrimera = [];
    for (let i = 0; i < 3; i++) {
      const page = await ctx.newPage();
      let primera = null;
      page.on("websocket", (ws) => {
        if (primera) return;
        primera = { connects: 0 };
        ws.on("framesent", (f) => { if (String(f.payload) === "40") primera.connects++; });
      });
      await page.route("**fonts.g**", (r) => r.abort());
      await page.goto(`${B}/externa?link=${encodeURIComponent(`https://meet.google.com/${meetCode()}`)}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
      if (/Companion activo/.test((await page.locator("body").textContent()) || "")) conectadas++;
      connectsEnLaPrimera.push(primera ? primera.connects : -1);
      await page.close();
    }
    check("la entrada de un clic (nombre recordado) conecta la capa de Unify SIEMPRE", conectadas === 3, `conectó ${conectadas}/3`);
    check("y manda UN solo CONNECT por conexión (dos hacían que el servidor cortara)",
      connectsEnLaPrimera.every((n) => n === 1), `CONNECT por intento: ${connectsEnLaPrimera.join(",")}`);
  }

  // ================= 2. Conversación real + traducción =================
  {
    const code = meetCode();
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.route("**/api/translate", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "translated line" }) })
    );
    const entro = await joinExternal(page, `https://meet.google.com/${code}`, "Anfitrión");
    check("entra a la reunión externa y conecta la capa de Unify",
      entro && page.url().includes("/externa/reunion") &&
        /Companion activo/.test((await page.locator("body").textContent()) || ""),
      page.url());
    const lang = page.getByTitle(/Idioma en el que ves los subtítulos/i);
    if (await exigir(lang, "el selector «Traducir a» está en el dock")) await lang.selectOption("en-US");

    // Tres personas hablando desde otros dispositivos.
    const socks = [];
    for (const n of ["Ana", "Bruno", "Caro"]) {
      const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
      await new Promise((res) => s.timeout(8000).emit("join-companion",
        { externalKey: `google-meet:${code}`, name: n, language: "es-AR" }, (e, r) => res(r)));
      socks.push(s);
    }
    await sleep(800);
    for (const [i, s] of socks.entries()) {
      s.emit("transcript-line", { alternatives: [`linea numero ${i + 1} de la reunion de prueba`], lang: "es-AR" });
      await sleep(900);
    }
    await sleep(2200);

    const stage = (await page.locator(".min-h-0.flex-1").first().textContent()) || "";
    const body = (await page.locator("body").textContent()) || "";
    check("aparecen las voces de los TRES participantes",
      ["Ana", "Bruno", "Caro"].every((n) => body.includes(n)),
      ["Ana", "Bruno", "Caro"].filter((n) => !body.includes(n)).join(",") || "todos");
    check("se muestra la traducción", body.includes("translated line"));
    check("conversación sin errores", bag.length === 0, bag.slice(0, 2).join(" | "));

    // ---- Reconexión: se cae y vuelve ----
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await sleep(600);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await sleep(1500);
    check("sobrevive a un corte de red simulado", bag.length === 0, bag.slice(0, 2).join(" | "));

    // ---- Salir limpio ----
    const salir = page.getByRole("button", { name: /Salir de la reunión/i });
    if (await exigir(salir, "hay un botón para salir de la reunión")) { await salir.click(); await sleep(1200); }
    // Como invitado, Unify pregunta si querés guardar la reunión en una cuenta
    // antes de salir: es lo correcto, hay que responderle.
    const prompt = page.getByText(/¿Guardar esta reunión\?/i);
    check("como invitado ofrece guardar la reunión antes de salir", (await prompt.count()) > 0);
    const skip = page.getByRole("button", { name: /Guardar \(iniciar sesión\)/i }).first();
    const other = page.locator("button").filter({ hasNotText: /Guardar \(iniciar/i });
    // Elegimos la opción secundaria (seguir sin guardar).
    const secondary = page.getByRole("button", { name: /^(?!Guardar \(iniciar).*$/ }).last();
    if (await prompt.count()) {
      // Por NOMBRE, no por índice (ver sim_malla): un botón transitorio que
      // se va mientras se recorre la lista corría los índices.
      const no = page
        .getByRole("button", { name: /sin guardar|Seguir|No, gracias|Salir igual|Descartar/i })
        .first();
      if (await no.count()) await no.click();
      await sleep(1800);
    }
    const path = await page.evaluate(() => location.pathname);
    check("salir de la reunión no deja la página rota", !path.includes("/externa/reunion"), `path=${path}`);
    check("sin errores al salir", bag.length === 0, bag.slice(0, 2).join(" | "));

    socks.forEach((s) => s.disconnect());
    await page.close();
  }

  // ================= 2b. «Guardar (iniciar sesión)» llega a /ingresar =================
  // Regresión de react-router 7: leaveMeeting() vacía el draft, la pantalla
  // se re-renderiza sin draft ANTES de irse y su guardia la mandaba a
  // /externa pisando el destino real (lo mismo le pasaba al historial al
  // cerrarse Zoom desde la app de escritorio: sim_persona_zoom).
  {
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    const letras = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    const codigoMeet = `${letras(3)}-${letras(4)}-${letras(3)}`;
    // La frase que se mete abajo se traduce al idioma del navegador: se
    // contesta acá, sin salir a internet (que en este entorno no hay).
    await page.route("**/api/translate", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "texto traducido de prueba" }) }));
    const entro = await joinExternal(page, `https://meet.google.com/${codigoMeet}`, "Invitada");
    await page.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    check("la invitada entra a la reunión externa", entro && page.url().includes("/externa/reunion"), page.url());
    // Algo que guardar: una frase por el puente. Sin nada dicho ni grabado,
    // salir es salir y NO se pregunta (ver 2f).
    await fetch(`${API}/api/meet-bridge/${encodeURIComponent(`google-meet:${codigoMeet}`)}/transcript`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Ana", text: "arrancamos con el presupuesto del trimestre", lang: "es-AR" }),
    }).catch(() => {});
    await sleep(1500);
    const salir = page.getByRole("button", { name: /Salir de la reunión/i });
    if (await exigir(salir, "la invitada tiene el botón para salir")) await salir.click();
    const guardar = page.getByRole("button", { name: /Guardar \(iniciar sesión\)/i }).first();
    await guardar.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    if (await exigir(guardar, "al salir puede elegir «Guardar (iniciar sesión)»")) {
      await guardar.click();
      await page.waitForURL(/\/ingresar/, { timeout: 8000 }).catch(() => {});
      await sleep(1200);
    }
    check("«Guardar» la lleva a iniciar sesión, no de vuelta al formulario de la externa",
      new URL(page.url()).pathname === "/ingresar", page.url());
    check("sin errores de JS al guardar y salir", bag.length === 0, bag.slice(0, 2).join(" | "));
    await page.close();
  }

  // ================= 2c. Zoom de OTRA cuenta (la foto real del iPad) =================
  // «cross account join error»: Zoom no deja que una app del Meeting SDK sin
  // su revisión entre a reuniones organizadas por OTRA cuenta. Unify lo trataba
  // como "falta la contraseña" (la reunión no tenía ninguna) y dejaba a la
  // persona en un callejón. Ahora sigue sola con Unify al lado, explica por
  // qué, y deja el botón para abrir la reunión en Zoom (con su enlace real).
  const ZOOM_LINK = "https://us05web.zoom.us/j/89123456789?pwd=Q2xhdWRlUGFzcw";
  const ZOOM_KEY = "zoom:89123456789";
  // El chunk real del SDK sale de Vite como módulo CommonJS envuelto y el
  // código que lo importa lee `import(...).then(M => M.<nombre>).default`,
  // con un nombre distinto en cada build: el falso se exporta con los MISMOS
  // nombres que el chunk de verdad (se leen del archivo servido).
  const SDK_FALSO = (motivo, nombres) => {
    const modulo = `{ default: { createClient() { return {
      async init() {}, on() {}, leaveMeeting() {},
      async join() { return { type: "JOIN_MEETING_FAILED", reason: ${JSON.stringify(motivo)}, errorCode: 3000 }; }
    }; } } }`;
    const alias = nombres.filter((n) => n !== "default").map((n) => `export { m as ${n} };`).join("\n");
    return `const m = ${modulo};\nexport default m.default;\n${alias}`;
  };
  async function servirSdkFalso(page, motivo) {
    await page.route("**/assets/embedded-*.js", async (r) => {
      const real = await (await r.fetch()).text().catch(() => "");
      const ultimo = [...real.matchAll(/export\{([^}]*)\}/g)].pop()?.[1] || "";
      const nombres = ultimo.split(",").map((par) => par.trim().split(/\s+as\s+/).pop()).filter(Boolean);
      await r.fulfill({ status: 200, contentType: "application/javascript", body: SDK_FALSO(motivo, nombres) });
    });
  }
  // Contexto NUEVO (sin nombre recordado): el formulario tiene que aparecer.
  const mkZoom = () => browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  // El servidor local no tiene credenciales de Zoom (/api/platforms dice
  // zoom:false y la pantalla ni ofrece el SDK). Acá se finge que sí, como en
  // producción, y la traducción se contesta sin salir a internet.
  async function comoEnProduccion(page) {
    await page.route("**/api/platforms", async (r) => {
      const res = await r.fetch();
      const j = await res.json().catch(() => ({}));
      await r.fulfill({ response: res, body: JSON.stringify({ ...j, zoom: true }) });
    });
    await page.route("**/api/translate", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "texto traducido de prueba" }) }));
  }
  async function entrarAdentroConSdkFalso(ctxZ, motivo) {
    const page = await ctxZ.newPage();
    const bag = [];
    watch(page, bag);
    let firmas = 0;
    await comoEnProduccion(page);
    await page.route("**/api/zoom/signature", (r) => { firmas++; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signature: "firma-de-prueba" }) }); });
    // El SDK de Zoom de verdad, reemplazado por uno que falla como Zoom falla.
    await servirSdkFalso(page, motivo);
    await page.goto(`${B}/externa?link=${encodeURIComponent(ZOOM_LINK)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.getByLabel("Tu nombre").fill("Invitado Zoom");
    await page.locator("details > summary").first().click();
    const adentro = page.getByRole("button", { name: /^Unirme acá dentro$/i });
    await adentro.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await adentro.click();
    await page.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
    return { page, bag, firmas: () => firmas };
  }
  async function unaFraseEnZoom() {
    await fetch(`${API}/api/meet-bridge/${encodeURIComponent(ZOOM_KEY)}/transcript`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Bruno", text: "tengo los números del trimestre listos para revisar", lang: "es-AR" }),
    }).catch(() => {});
    await sleep(1500);
  }
  {
    const ctxZ = await mkZoom();
    const { page, bag, firmas } = await entrarAdentroConSdkFalso(ctxZ, "cross account join error");
    check("Zoom de otra cuenta: entra a la reunión externa igual", page.url().includes("/externa/reunion"), page.url());
    check("y pidió la firma (intentó de verdad el SDK)", firmas() >= 1, `firmas=${firmas()}`);
    check("NO pide una contraseña que la reunión no tiene", (await page.locator("#zoom-inline-passcode").count()) === 0 && (await page.getByRole("alertdialog").count()) === 0);
    const abrir = page.getByRole("link", { name: /Abrir en Zoom/i });
    check("sigue sola con Unify al lado, con el botón para abrir la reunión en Zoom", (await abrir.count()) === 1);
    const href = (await abrir.first().getAttribute("href").catch(() => "")) || "";
    check("y el botón lleva al enlace REAL (con el número y su pwd, que Zoom sí entiende)", href.includes("89123456789") && href.includes("pwd=Q2xhdWRlUGFzcw"), href);
    const nota = (await page.getByRole("note").first().textContent().catch(() => "")) || "";
    check("explica por qué (otra cuenta de Zoom) en vez de dejar un error críptico", /otra cuenta/i.test(nota) && /Zoom/.test(nota), nota.slice(0, 90));
    // Salir tiene que SALIR (con algo que guardar, pregunta; y la pregunta se ve).
    await unaFraseEnZoom();
    await page.getByRole("button", { name: /Salir de la reunión/i }).click();
    const dialogo = page.getByRole("dialog", { name: /Guardar esta reunión/i });
    await dialogo.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    check("al salir, el aviso de guardar aparece A LA VISTA", (await dialogo.count()) === 1 && (await dialogo.isVisible().catch(() => false)));
    await page.getByRole("button", { name: /No, gracias/i }).click().catch(() => {});
    await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 35000 }).catch(() => {});
    check("y «No, gracias» la lleva al inicio", new URL(page.url()).pathname === "/", page.url());
    check("sin errores de JS en el camino de otra cuenta", bag.length === 0, bag.slice(0, 2).join(" | "));
    await ctxZ.close();
  }

  // ================= 2d. Contraseña incorrecta: la tarjeta NO tapa «¿Guardar?» =================
  // Con la contraseña mal, la tarjeta de error del SDK (z-index al tope para
  // tapar los diálogos de Zoom) escondía el aviso de «¿Guardar esta reunión?»
  // y «Salir» parecía no hacer nada (la foto). Ahora la tarjeta se retira al
  // salir y el aviso vive por encima de todo.
  {
    const ctxZ = await mkZoom();
    const { page, bag } = await entrarAdentroConSdkFalso(ctxZ, "Meeting passcode wrong");
    const tarjeta = page.getByRole("alertdialog", { name: /Zoom pide la contraseña/i });
    check("con la contraseña mal, la tarjeta dice que Zoom pide la contraseña", (await tarjeta.count()) === 1);
    check("y ofrece escribirla", (await page.locator("#zoom-inline-passcode").count()) === 1);
    check("y PRIMERO la salida que siempre anda: abrir en Zoom con Unify al lado", (await tarjeta.getByRole("button", { name: /Abrir en Zoom y seguir con Unify al lado/i }).count()) === 1);
    await unaFraseEnZoom();
    await tarjeta.getByRole("button", { name: /^Salir$/i }).click();
    const dialogo = page.getByRole("dialog", { name: /Guardar esta reunión/i });
    await dialogo.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
    const noGracias = page.getByRole("button", { name: /No, gracias/i });
    const llega = await noGracias.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(top && (top === el || el.contains(top)));
    }).catch(() => false);
    check("«Salir» muestra el aviso de guardar POR ENCIMA de la tarjeta (el clic llega)", (await dialogo.isVisible().catch(() => false)) && llega, `clic llega=${llega}`);
    check("y la tarjeta de error ya no está tapando", (await page.getByRole("alertdialog").count()) === 0);
    await noGracias.click().catch(() => {});
    await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 35000 }).catch(() => {});
    check("y sale de verdad", new URL(page.url()).pathname === "/", page.url());
    check("sin errores de JS con la contraseña mal", bag.length === 0, bag.slice(0, 2).join(" | "));
    await ctxZ.close();
  }

  // ================= 2e. Pegar el enlace y unirse DIRECTO, como en Zoom =================
  // Lo que la persona pidió: pegar el enlace y entrar. Para Zoom el camino
  // que anda siempre es abrir la reunión en Zoom (que entiende el enlace con
  // su contraseña) con el mismo clic, y quedarse con Unify al lado.
  {
    const ctxZ = await mkZoom();
    const page = await ctxZ.newPage();
    const bag = [];
    watch(page, bag);
    let firmas = 0;
    await comoEnProduccion(page);
    page.on("request", (r) => { if (r.url().includes("/api/zoom/signature")) firmas++; });
    await page.goto(`${B}/externa?link=${encodeURIComponent(ZOOM_LINK)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.getByLabel("Tu nombre").fill("Invitado Zoom");
    const directo = page.getByRole("button", { name: /Unirme en Zoom/i });
    check("con un enlace de Zoom, el botón principal es unirse EN Zoom (Unify al lado)", (await directo.count()) === 1);
    check("y no pide contraseña a la vista (queda para «intentar adentro», plegado)", !(await page.getByLabel(/Contraseña de la reunión/i).first().isVisible().catch(() => false)));
    // zoom.us no se alcanza desde acá (la ventana termina en una página de
    // error de Chrome): lo que importa es QUÉ pidió la ventana nueva.
    let urlZoom = "";
    ctxZ.on("request", (r) => { if (!urlZoom && /zoom\.us\/j\//.test(r.url())) urlZoom = r.url(); });
    const popup = ctxZ.waitForEvent("page", { timeout: 6000 }).catch(() => null);
    await directo.click();
    const nueva = await popup;
    await page.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    check("con ese MISMO clic se abre la reunión en Zoom (enlace real, con pwd)", Boolean(nueva) && urlZoom.includes("zoom.us/j/89123456789") && urlZoom.includes("pwd=Q2xhdWRlUGFzcw"), urlZoom || nueva?.url() || "sin ventana");
    check("y Unify queda al lado, en la reunión", page.url().includes("/externa/reunion") && (await page.getByRole("link", { name: /Abrir en Zoom/i }).count()) === 1, page.url());
    check("sin pasar por el SDK (ni una firma pedida)", firmas === 0, `firmas=${firmas}`);
    check("sin errores de JS en el camino directo", bag.length === 0, bag.slice(0, 2).join(" | "));
    await ctxZ.close();
  }

  // ================= 2f. Reunión vacía: salir es salir =================
  // Sin una frase ni grabación no hay nada que guardar: preguntar «¿Guardar
  // esta reunión?» era ruido. Con la grabación automática apagada y nadie
  // hablando, «Salir» va al inicio derecho.
  {
    const ctxZ = await mkZoom();
    await ctxZ.addInitScript(() => { try { localStorage.setItem("unify_autorecord_externa", "0"); } catch {} });
    const page = await ctxZ.newPage();
    const bag = [];
    watch(page, bag);
    await page.goto(`${B}/externa?link=${encodeURIComponent(`https://meet.google.com/${meetCode()}`)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.getByLabel("Tu nombre").fill("Invitada Breve");
    await page.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await page.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /Salir de la reunión/i }).click();
    await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 8000 }).catch(() => {});
    check("sin nada dicho ni grabado, «Salir» no pregunta: va al inicio", new URL(page.url()).pathname === "/" && (await page.getByRole("dialog", { name: /Guardar esta reunión/i }).count()) === 0, page.url());
    check("sin errores de JS al salir de una reunión vacía", bag.length === 0, bag.slice(0, 2).join(" | "));
    await ctxZ.close();
  }

  // ================= 3. Refrescar la URL de la reunión =================
  {
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.goto(`${B}/externa/reunion`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const path = await page.evaluate(() => location.pathname);
    check("entrar directo a la URL de reunión redirige limpio", path === "/externa", `path=${path}`);
    check("sin errores al redirigir", bag.length === 0, bag.slice(0, 2).join(" | "));
    await page.close();
  }

  // ================= 4. Móvil / tablet (como el iPad del usuario) =================
  {
    const mob = await browser.newContext({
      viewport: { width: 820, height: 1180 }, // iPad en vertical
      permissions: ["microphone"],
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
    const page = await mob.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await joinExternal(page, `https://meet.google.com/${meetCode()}`, "iPad");
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("en tablet no hay desborde horizontal", ov <= 2, `desborde=${ov}px`);
    check("en tablet se ve la pantalla de subtítulos", (await page.getByText(/subtítulos aparecen acá|Escuchando|Micrófono/i).count()) > 0);
    check("en tablet el dock es accesible", (await page.getByTitle(/Invitar a los demás/i).count()) > 0);
    check("sin errores en tablet", bag.length === 0, bag.slice(0, 2).join(" | "));
    await mob.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
