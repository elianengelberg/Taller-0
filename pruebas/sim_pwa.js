// La PWA instalable, contra el build de producción con las cabeceras REALES
// de vercel.json: manifest válido, service worker activo, share_target que
// cae en /externa ya detectado, y el cascarón abriendo sin red.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  console.log("\n── 1. Manifest y service worker ──");
  {
    const res = await fetch(`${B}/manifest.webmanifest`);
    check("el manifest responde 200 con su MIME", res.status === 200 && (res.headers.get("content-type") ?? "").includes("manifest"));
    const man = await res.json();
    check("standalone + id + nombre", man.display === "standalone" && man.id === "/" && /Unify/.test(man.name));
    check("share_target hacia /externa con url y text",
      man.share_target?.action === "/externa" && man.share_target?.params?.url === "url" && man.share_target?.params?.text === "text");
    check("focus-existing (no revienta una reunión en curso)", man.launch_handler?.client_mode === "focus-existing");
    check("íconos 192 + 512 + maskable", man.icons?.length === 3 && man.icons.some((i) => i.purpose === "maskable"));
    for (const icon of man.icons ?? []) {
      const r = await fetch(`${B}${icon.src}`);
      check(`ícono ${icon.src} existe`, r.status === 200);
    }
    const sw = await fetch(`${B}/sw.js`);
    const cuerpo = await sw.text();
    check("sw.js responde como JavaScript", sw.status === 200 && (sw.headers.get("content-type") ?? "").includes("javascript"));
    check("los bundles pesados NO están en el precache",
      !cuerpo.match(/"url":"assets\/(sdk\.bundle|embedded)-[^"]+"/));

    // La versión de la extensión, publicada junto al ZIP: el background de la
    // extensión la lee desde su service worker para avisar "hay una versión
    // nueva" a quien instaló por ZIP. Sin CORS abierto ese fetch moriría.
    const vers = await fetch(`${B}/version-extension.json`);
    check("version-extension.json responde 200", vers.status === 200);
    check("con CORS abierto (la extensión lo lee desde otro origen)",
      vers.headers.get("access-control-allow-origin") === "*");
    check("sin caché (un deploy nuevo se ve al toque)",
      /no-cache/.test(vers.headers.get("cache-control") ?? ""), vers.headers.get("cache-control") ?? "(nada)");
    const vdata = await vers.json().catch(() => ({}));
    const manifestExt = JSON.parse(require("fs").readFileSync(require("path").resolve(__dirname, "../extension/manifest.json"), "utf8"));
    check("y declara la MISMA versión que el manifest de la extensión",
      vdata.version === manifestExt.version, `web=${vdata.version} ext=${manifestExt.version}`);
  }

  console.log("\n── 2. El service worker vivo ──");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--no-proxy-server"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.goto(`${B}/`, { waitUntil: "networkidle" });
  const swState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "no-support";
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return reg?.active?.state ?? "sin-registro";
  });
  check("el SW queda ACTIVO bajo la CSP de producción", swState === "activated", swState);

  console.log("\n── 2b. El tema predeterminado ──");
  {
    // Perfil nuevo, sin nada guardado: la primera impresión es la pantalla
    // CLARA (decisión de producto). Quien prefiera oscuro u "auto" lo elige
    // en Ajustes y queda guardado -- eso también se prueba.
    const p = await ctx.newPage();
    // Con el SISTEMA en oscuro: es el caso que distingue "predeterminado
    // claro" de "auto" (en un sistema claro, ambos se ven iguales y la
    // comprobación no probaría nada).
    await p.emulateMedia({ colorScheme: "dark" });
    await p.goto(`${B}/`, { waitUntil: "networkidle" });
    check("sin elección guardada, la app abre en tema claro (aun con el sistema oscuro)",
      (await p.evaluate(() => document.documentElement.dataset.theme)) === "light",
      await p.evaluate(() => document.documentElement.dataset.theme));
    check("y el fondo pintado es claro de verdad",
      await p.evaluate(() => {
        const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
        return (rgb[0] + rgb[1] + rgb[2]) / 3 > 160;
      }));
    // La elección guardada le gana al predeterminado.
    await p.evaluate(() => localStorage.setItem("unify_theme", "dark"));
    await p.reload({ waitUntil: "networkidle" });
    check("quien eligió oscuro lo conserva al recargar",
      (await p.evaluate(() => document.documentElement.dataset.theme)) === "dark");
    await p.evaluate(() => localStorage.removeItem("unify_theme"));
    await p.close();
  }

  console.log("\n── 3. Compartir un enlace hacia la app ──");
  {
    await page.goto(`${B}/externa?url=${encodeURIComponent("https://us05web.zoom.us/j/91234567890?pwd=abc")}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    check("con ?url= la reunión de Zoom queda detectada", /Zoom/.test(await page.evaluate(() => document.body.innerText)));
    const invitacion = "Juana te invita: https://meet.jit.si/EquipoUnify a las 15hs";
    await page.goto(`${B}/externa?text=${encodeURIComponent(invitacion)}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    check("con ?text= (invitación pegada) detecta Jitsi", /Jitsi/.test(await page.evaluate(() => document.body.innerText)));
  }

  console.log("\n── 4. Modo avión ──");
  {
    await page.goto(`${B}/`, { waitUntil: "networkidle" });
    await ctx.setOffline(true);
    await page.goto(`${B}/historial`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    check("sin red, la app abre desde el caché", /Unify|Iniciar sesión|reuni/i.test(t), t.slice(0, 60).replace(/\n/g, " "));
    await ctx.setOffline(false);
  }


  console.log("\n── 5. La app se actualiza sola (nadie instala versiones a mano) ──");
  // El caso real: se sube un deploy y la app YA INSTALADA (Windows, Mac,
  // iPhone, Android) tiene que quedar en la versión nueva sin que la persona
  // toque nada. Acá se prueba de verdad: se cambia el sw.js servido y se mira
  // QUÉ VERSIÓN está atendiendo a la página -- sin un solo clic de por medio.
  {
    const fs = require("fs");
    const SW = require("path").resolve(__dirname, "../client/dist/sw.js");
    const original = fs.readFileSync(SW, "utf8");
    // Cada versión de prueba se delata: contesta /__prueba-version con su
    // nombre. Si la página lo lee, es que ESA versión la está controlando.
    const publicar = (marca) => fs.writeFileSync(SW, `${original}
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).pathname === "/__prueba-version") e.respondWith(new Response(${JSON.stringify(marca)}));
});
`);
    const version = (p) => p.evaluate(async () => {
      const t = await fetch("/__prueba-version").then((r) => r.text()).catch(() => "?");
      return t.startsWith("<") ? "vieja" : t.trim();
    }).catch(() => "?");
    const cargas = (p) => p.evaluate(() => Number(sessionStorage.getItem("cargas") || 0)).catch(() => 0);
    const hayEspera = (p) => p.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return Boolean(r?.waiting);
    }).catch(() => false);
    const buscarVersion = (p) => p.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r?.update().catch(() => {});
    }).catch(() => {});
    const esperar = async (p, fn, ms = 30_000) => {
      const hasta = Date.now() + ms;
      while (Date.now() < hasta) {
        try { if (await fn(p)) return true; } catch { /* recargando */ }
        await p.waitForTimeout(500);
      }
      return false;
    };

    // Contador de cargas de la pestaña: si sube solo, la app se recargó sola.
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem("cargas", String(Number(sessionStorage.getItem("cargas") || 0) + 1));
      } catch {}
    });

    try {
      // Una sola pestaña abierta. Con dos, la que NO está escribiendo aplica
      // la versión y recarga a todas (correcto en la vida real -- el service
      // worker es uno solo para el origen -- pero acá taparía lo que se mide).
      await page.close();
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
      await p.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
      await p.evaluate(() => navigator.serviceWorker.ready);
      check("arranca con la versión que había", (await version(p)) === "vieja");

      // 5a. Escribiendo un formulario NO se actualiza: la recarga borraría lo
      //     que la persona está tipeando. Teclas de verdad (isTrusted).
      const campo = p.locator("input").first();
      await campo.click();
      await p.keyboard.type("ana@ejemplo.com", { delay: 20 });
      publicar("v2");
      await buscarVersion(p);
      check("la versión nueva se baja y queda esperando", await esperar(p, hayEspera, 20_000));
      await p.waitForTimeout(20_000); // más que el sondeo de 15s: tuvo su chance
      check("NO se actualiza encima de un formulario a medio escribir",
        (await cargas(p)) === 1 && (await version(p)) === "vieja" && (await hayEspera(p)),
        `cargas=${await cargas(p)} versión=${await version(p)}`);
      check("y lo escrito sigue ahí", (await campo.inputValue()) === "ana@ejemplo.com");

      // 5b. Se borra el texto: ya no hay nada que perder -> se aplica SOLA.
      await campo.click();
      await p.keyboard.press("Control+a");
      await p.keyboard.press("Backspace");
      check("apenas el momento es seguro se actualiza sola, sin un solo clic",
        await esperar(p, async (x) => (await version(x)) === "v2", 40_000),
        `cargas=${await cargas(p)}`);
      check("y la recarga la hizo la app, no la persona", (await cargas(p)) >= 2);
      check("no queda ninguna versión esperando", !(await hayEspera(p)));
      check("la app sigue en pie después de actualizarse sola",
        await esperar(p, (x) => x.evaluate(() => /Unify|Iniciar sesi|Correo/i.test(document.body.innerText)), 20_000),
        (await p.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 40).replace(/\n/g, " "));

      // 5c. La versión que llegó con la app cerrada (el caso del iPhone: se
      //     cierra la app y días después se abre). Tiene que abrir YA en la
      //     versión nueva, sin recargas raras ni avisos.
      await campo.click();
      await p.keyboard.type("bloqueo", { delay: 20 });
      publicar("v3");
      await buscarVersion(p);
      check("una tercera versión queda esperando con la app en uso",
        await esperar(p, hayEspera, 20_000));
      await p.close(); // cerrar la app

      const p2 = await ctx.newPage();
      p2.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
      await p2.goto(`${B}/`, { waitUntil: "domcontentloaded" });
      check("al volver a abrirla arranca directamente en la versión nueva",
        await esperar(p2, async (x) => (await version(x)) === "v3", 30_000),
        `versión=${await version(p2)}`);
      check("sin quedar nada pendiente ni pedir nada", !(await hayEspera(p2)));
      await p2.close();

      // 5d. EL BOTÓN "Buscar actualización ahora" de /instalar. La app se
      //     actualiza sola, pero quien acaba de leer que hay una versión
      //     nueva quiere COMPROBARLO en el momento -- y ese botón tiene que
      //     hacer algo de verdad, no decir "ya estás al día" y quedarse.
      const p3 = await ctx.newPage();
      p3.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
      await p3.goto(`${B}/instalar`, { waitUntil: "networkidle" });
      await p3.evaluate(() => navigator.serviceWorker.ready);

      const boton = p3.getByRole("button", { name: /Buscar actualizaci/i });
      check("el botón de buscar actualización está a la vista", (await boton.count()) > 0);

      // Sin nada nuevo publicado, tiene que decir la verdad: estás al día.
      await boton.first().click();
      // Y sobre todo: CONTESTA. Antes se quedaba en "Buscando…" para siempre
      // cuando el pedido del service worker no resolvía, y no había manera de
      // saber si estabas al día o si el botón estaba roto.
      check("sin novedades, contesta que ya estás en la última versión",
        await esperar(p3, (x) => x.evaluate(() => /última versión/i.test(document.body.innerText)), 25_000),
        ((await p3.evaluate(() => document.body.innerText).catch(() => "")).match(/Buscar actualización ahora[\s\S]{0,45}/)?.[0] ?? "?").replace(/\n/g, " | "));

      // Y ahora sí: se publica una versión nueva y se toca el botón.
      publicar("v4");
      const antes = await cargas(p3);
      await p3.getByRole("button", { name: /Buscar actualizaci/i }).first().click();
      check("con una versión nueva, el botón la APLICA de verdad",
        await esperar(p3, async (x) => (await version(x)) === "v4", 40_000),
        `versión=${await version(p3)}`);
      check("y la pantalla se recargó sola en la versión nueva", (await cargas(p3)) > antes,
        `cargas: ${antes} → ${await cargas(p3)}`);
      await p3.close();
    } finally {
      fs.writeFileSync(SW, original);
    }
  }

  check("sin errores de JavaScript", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
