// Live UI simulation of joining EXTERNAL meetings (Zoom/Meet/Teams/Jitsi):
// detection, routing to the right embed, companion socket connect, and
// graceful errors when a platform's server config is missing (no white screen).
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const BASE = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

async function detectAndJoin(page, link, { passcode } = {}) {
  await page.goto(`${BASE}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill(link);
  await page.getByLabel("Tu nombre").fill("Tester");
  await page.getByRole("button", { name: /^Detectar$/ }).click();
  await page.waitForTimeout(400);
  if (passcode !== undefined) {
    const pc = page.getByLabel(/Contraseña de la reunión/i);
    if (await pc.count()) await pc.first().fill(passcode);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });

  // ---- Detection + routing (no external SDma load needed) ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

    // Un enlace de una plataforma que no conocemos por nombre ya NO es un
    // callejón sin salida: se ofrece acompañarlo con Unify al lado (subtítulos,
    // traducción, IA y grabación no dependen de la otra plataforma).
    await detectAndJoin(p, "https://example.com/foo");
    check("plataforma desconocida → se ofrece Unify al lado",
      (await p.getByText(/No conocemos/i).count()) > 0 &&
        (await p.getByRole("button", { name: /Unirme con Unify al lado/i }).count()) > 0);
    // Un enlace sin sala sigue sin ofrecerse: no identifica ninguna reunión.
    await detectAndJoin(p, "https://example.com/");
    check("enlace sin sala → sigue diciendo que no lo reconoce",
      (await p.getByText(/No reconocimos ese enlace/i).count()) > 0);

    // Zoom detection
    await detectAndJoin(p, "https://us05web.zoom.us/j/1234567890?pwd=abc");
    check("Zoom detectado con número", (await p.getByText(/Reconocimos una reunión de/i).count()) > 0 && (await p.getByText(/Zoom/).count()) > 0);
    check("Zoom: se muestra el número extraído del enlace", (await p.getByText(/1234567890/).count()) > 0);
    // Con credenciales ofrece unirse acá dentro (+ contraseña); sin ellas avisa y
    // ofrece abrirlo afuera. Las dos ramas son correctas: se valida la coherencia.
    {
      const joinable = (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) > 0;
      const pass = (await p.getByLabel(/Contraseña de la reunión/i).count()) > 0;
      const warned = (await p.getByText(/no tiene configuradas las credenciales/i).count()) > 0;
      const openOut = (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0;
      check("Zoom: la oferta es coherente con la config del servidor",
        (joinable && pass && !warned) || (!joinable && warned && openOut),
        `unirse=${joinable} pass=${pass} aviso=${warned} abrir=${openOut}`);
    }

    // Meet detection
    await detectAndJoin(p, "https://meet.google.com/abc-defg-hij");
    check("Meet detectado con código", (await p.getByText(/Google Meet/i).count()) > 0);
    check("Meet ofrece unirse (companion + extensión)", (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) > 0);

    // Teams detection
    await detectAndJoin(p, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0");
    check("Teams detectado", (await p.getByText(/Microsoft Teams/i).count()) > 0);

    // Jitsi detection
    await detectAndJoin(p, "https://meet.jit.si/UnifyTestRoom123");
    check("Jitsi detectado con sala", (await p.getByText(/Jitsi Meet/i).count()) > 0);

    // Zoom personal/vanity link (no number) → honest "can't join, open in Zoom"
    await detectAndJoin(p, "https://zoom.us/my/somename");
    check("Zoom sin número → no ofrece unirse acá, ofrece abrir en Zoom", (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0);

    check("sin errores de página en toda la detección", errs.length === 0, errs[0] || "");
    await p.close();
  }

  // ---- "Unirme" abre la reunión REAL (el bug del celular: pegabas el link
  //      de Meet y Unify te dejaba en su capa sin llevarte nunca a la
  //      reunión). El clic tiene que abrir Meet en su pestaña/app Y dejar la
  //      capa de Unify con un botón grande para volver a abrirla. ----
  {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__abiertos = [];
      window.open = (url) => {
        window.__abiertos.push(String(url));
        return null;
      };
    });
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.google.com/abc-defg-hij");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    const abiertos = await p.evaluate(() => window.__abiertos);
    check("el clic de «Unirme» ABRE la reunión real de Meet (pestaña/app)",
      abiertos.some((u) => u.includes("meet.google.com/abc-defg-hij")), JSON.stringify(abiertos));
    check("y la capa Unify deja un botón GRANDE para volver a abrirla",
      (await p.getByRole("link", { name: /Abrir la reunión de Meet/i }).count()) > 0);
    await p.close();
  }
  {
    // Una embebible (Jitsi) corre ADENTRO: abrir otra copia afuera sería
    // duplicar la reunión.
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__abiertos = [];
      window.open = (url) => {
        window.__abiertos.push(String(url));
        return null;
      };
    });
    await p.route((url) => url.hostname.endsWith("jit.si"), (r) => r.abort());
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.jit.si/SalaAbrirReal1");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForTimeout(1500);
    check("una plataforma embebible (Jitsi) NO abre pestañas de más",
      (await p.evaluate(() => window.__abiertos)).length === 0);
    await p.close();
  }

  // ---- Graceful errors joining unconfigured platforms (Zoom/Teams 503) ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

    // Zoom sin credenciales: desde el cambio de "aviso previo", ya NO se ofrece
    // unirse acá dentro -- se avisa antes y se ofrece abrirlo en Zoom.
    await detectAndJoin(p, "https://us05web.zoom.us/j/1234567890", { passcode: "" });
    await p.waitForTimeout(800);
    check("Zoom sin config: avisa antes y NO ofrece unirse acá dentro",
      (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) === 0 &&
      (await p.getByText(/no tiene configuradas las credenciales/i).count()) > 0);
    check("Zoom sin config: ofrece abrirlo en su plataforma",
      (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0);
    check("Zoom: la página no crashea", errs.length === 0, errs[0] || "");
    await p.close();
  }

  // ---- Jitsi companion connects (Unify layer) even if external script blocked ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    // Block the external Jitsi script to simulate it being unavailable; the
    // Unify companion layer must still connect and the page must not crash.
    await p.route("**external_api.js", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
    await detectAndJoin(p, "https://meet.jit.si/UnifyRoomXYZ");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForTimeout(2500);
    check("Jitsi: la capa Unify conecta (companion)", (await p.getByTitle(/Invitar a los demás/i).count()) > 0);
    check("Jitsi con script bloqueado: no crashea, muestra algo", errs.length === 0, errs[0] || "");
    // Regla de la casa: DENTRO de la reunión también tiene que haber un
    // Volver a la vista en el encabezado (el Salir del dock no alcanza).
    check("Jitsi adentro: hay un Volver en el encabezado",
      (await p.getByRole("button", { name: /Volver/i }).count()) > 0);
    await p.close();
  }

  // ---- Regla de la casa: TODA pantalla tiene un "Volver" a la vista --------
  // (Salvo el inicio, que es la raíz.) Esto existe porque ya pasó dos veces
  // que una pantalla quedaba sin salida; acá se recorren todas las rutas.
  {
    const rutas = [
      "/instalar", "/privacidad", "/soporte", "/ingresar", "/registrarse",
      "/verificar-email", "/recuperar", "/restablecer", "/crear", "/unirse",
      "/externa",
    ];
    const p = await ctx.newPage();
    for (const ruta of rutas) {
      await p.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(600);
      const visible = await p.getByText(/volver/i).count();
      check(`hay un Volver a la vista en ${ruta}`, visible > 0, `coincidencias=${visible}`);
    }
    await p.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SIM ERROR:", e.message, e.stack); process.exit(1); });
