// Los botones y las pantallas, tocados de verdad en un navegador real.
//
// Lo que busca son los bugs que sólo aparecen usando la app con la mano:
// botones muertos (lindos pero sin nada atrás), doble envío por doble clic
// (dos cuentas, dos correos, dos reuniones), botones que quedan deshabilitados
// para siempre tras un error, y pantallas que tiran errores de JavaScript.
//
// Además mide accesibilidad básica -- tamaño real de los controles y foco
// visible con teclado -- porque esto lo va a usar gente de todas las edades y
// un botón de 20px no se toca con el pulgar.
//
// Requiere: build servido en 4174 (serve_csp) y el servidor real en 4001.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const rnd = () => Math.random().toString(36).slice(2, 9);

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--no-proxy-server"] });
  const ctx = await browser.newContext();
  const errs = [];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(`${page.url().replace(B, "")}: ${e.message.slice(0, 120)}`));

  // ═══════ 1. Ninguna pantalla tiene botones muertos ═══════
  console.log("\n── 1. Botones que hacen algo ──");
  const PANTALLAS = ["/", "/ingresar", "/registrarse", "/recuperar", "/instalar", "/soporte", "/privacidad", "/verificar-email"];
  for (const ruta of PANTALLAS) {
    await page.goto(`${B}${ruta}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);

    // Un <button> sin onClick, sin type=submit y fuera de un form es un botón
    // pintado: la persona lo toca y no pasa nada, que es de los bugs que peor
    // se sienten.
    const muertos = await page.evaluate(() => {
      const sospechosos = [];
      for (const b of document.querySelectorAll("button")) {
        if (b.disabled || b.offsetParent === null) continue;
        const enForm = Boolean(b.closest("form")) && b.type !== "button";
        // Un botón DENTRO de un enlace no necesita onClick: el clic lo maneja
        // el <a> que lo envuelve (patrón normal de la app para "Descargar" o
        // "Ir a…"). Contarlo como muerto era un falso positivo de esta prueba.
        const enEnlace = Boolean(b.closest("a[href]"));
        // React pone los handlers como propiedades internas; se detecta por
        // las claves __reactProps que expone el DOM.
        const clave = Object.keys(b).find((k) => k.startsWith("__reactProps"));
        const tieneOnClick = clave ? typeof b[clave]?.onClick === "function" : false;
        if (!enForm && !enEnlace && !tieneOnClick) sospechosos.push((b.textContent || "").trim().slice(0, 40));
      }
      return sospechosos;
    });
    check(`${ruta}: ningún botón muerto`, muertos.length === 0, muertos.join(" | "));

    // Enlaces rotos hacia adentro: un href a una ruta que no existe cae en la
    // SPA y muestra el inicio, que confunde más que un error.
    const rutasValidas = new Set([...PANTALLAS, "/historial", "/reunion", "/externa", "/restablecer", "/unirse", "/crear"]);
    const internos = await page.evaluate(() =>
      // Los enlaces a ARCHIVOS (el ZIP, el instalador, el perfil de Apple) no
      // son rutas de la aplicación: se descargan, y que existan lo comprueba
      // sim_instalar bajándolos de verdad.
      Array.from(document.querySelectorAll("a[href^='/']"))
        .filter((a) => !a.hasAttribute("download") && !/\.[a-z0-9]{2,12}$/i.test(a.getAttribute("href") || ""))
        .map((a) => a.getAttribute("href"))
    );
    const raros = internos.filter((h) => !rutasValidas.has((h || "").split("?")[0].split("#")[0]) && !h.startsWith("/instalar"));
    check(`${ruta}: los enlaces internos apuntan a rutas reales`, raros.length === 0, raros.join(" | "));
  }

  // ═══════ 2. Doble clic no manda dos veces ═══════
  console.log("\n── 2. El doble clic no duplica ──");
  {
    await page.goto(`${B}/registrarse`, { waitUntil: "networkidle" });
    let registros = 0;
    await page.route("**/api/auth/register", async (route) => {
      registros += 1;
      // Se responde lento a propósito: así el segundo clic cae MIENTRAS el
      // primero sigue en vuelo, que es cuando el bug se manifiesta.
      await new Promise((r) => setTimeout(r, 1200));
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Prueba" }) });
    });
    await page.fill("input[type='email']", `boton-${rnd()}@prueba.local`);
    const claves = await page.locator("input[type='password']").all();
    for (const c of claves) await c.fill("ContraseñaLarga123!");
    const nombre = page.locator("input[type='text']").first();
    if (await nombre.count()) await nombre.fill("Ana Prueba");

    const enviar = page.locator("button[type='submit']").first();
    await enviar.click();
    await enviar.click({ force: true }).catch(() => {}); // el segundo, encima del primero
    await page.waitForTimeout(2500);
    check("registrarse dos veces seguidas manda UNA sola vez", registros === 1, `envíos=${registros}`);
    check("y tras el error el botón vuelve a estar usable (no queda muerto)",
      await enviar.isEnabled());
    await page.unroute("**/api/auth/register");
  }

  // ═══════ 3. Tamaño y foco: usable por cualquiera ═══════
  console.log("\n── 3. Se puede usar con el pulgar y con el teclado ──");
  {
    await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
    const chicos = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button, input, a.btn"))
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ t: (el.textContent || el.getAttribute("placeholder") || el.type || "").trim().slice(0, 24), h: el.getBoundingClientRect().height }))
        .filter((x) => x.h > 0 && x.h < 36)
    );
    check("los controles miden al menos 36px de alto", chicos.length === 0,
      chicos.map((c) => `${c.t}=${Math.round(c.h)}px`).join(" | "));

    // Con teclado: el foco tiene que VERSE. Sin esto, quien no usa mouse
    // navega a ciegas.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return { tag: el.tagName, outline: s.outlineStyle, ancho: s.outlineWidth, sombra: s.boxShadow };
    });
    check("al navegar con Tab, el elemento enfocado se ve",
      Boolean(foco) && (foco.outline !== "none" || (foco.sombra && foco.sombra !== "none")),
      JSON.stringify(foco));
  }

  // ═══════ 4. La pantalla del código de 6 dígitos ═══════
  console.log("\n── 4. El código de 6 dígitos, usado a mano ──");
  {
    await page.goto(`${B}/verificar-email`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const casillas = page.locator("input[inputmode='numeric']");
    check("aparecen las 6 casillas", (await casillas.count()) === 6);

    // Escribir dígito por dígito: el foco tiene que ir solo a la siguiente.
    await casillas.nth(0).click();
    await page.keyboard.type("4");
    const focoTras1 = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check("al escribir un dígito, el foco salta solo a la casilla siguiente",
      /2 de 6/.test(focoTras1 ?? ""), focoTras1 ?? "?");

    // Borrar con Backspace vuelve a la anterior.
    await page.keyboard.press("Backspace");
    const focoTrasBorrar = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check("y Backspace en una casilla vacía vuelve a la anterior",
      /1 de 6/.test(focoTrasBorrar ?? ""), focoTrasBorrar ?? "?");

    // Sin sesión iniciada, la pantalla pide el email además del código (el
    // servidor busca el código POR dirección). Se completa como lo haría una
    // persona antes de escribir los dígitos.
    await page.locator("input[type='email']").fill("ana@prueba.local");

    // Pegar el código entero (lo que hace todo el mundo desde el correo).
    let enviados = 0;
    await page.route("**/api/auth/verify-email/code", (route) => {
      enviados += 1;
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Ese código no es correcto. Te quedan 4 intentos." }) });
    });
    await casillas.nth(0).click();
    await page.keyboard.type("482913");
    await page.waitForTimeout(1500);
    const valores = await casillas.evaluateAll((els) => els.map((e) => e.value).join(""));
    check("escribir los 6 dígitos los reparte en las casillas y ENVÍA solo",
      enviados === 1, `envíos=${enviados} casillas="${valores}"`);
    const err = await page.locator("[role='alert']").textContent().catch(() => "");
    check("un código incorrecto se explica con los intentos que quedan",
      /no es correcto/i.test(err) && /4 intentos/.test(err), err.slice(0, 60));
    const trasError = await casillas.evaluateAll((els) => els.map((e) => e.value).join(""));
    check("y las casillas se vacían para reintentar sin borrar a mano",
      trasError === "", `"${trasError}"`);
    await page.unroute("**/api/auth/verify-email/code");
  }

  check("ninguna pantalla tiró errores de JavaScript", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
