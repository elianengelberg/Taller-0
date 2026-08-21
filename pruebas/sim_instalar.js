// El centro de instalación, POR DISPOSITIVO: la página se abre "como
// Windows", "como Mac" y "como iPhone/iPad" (user agents reales) y tiene que
// mostrar en cada caso SOLO los pasos que le tocan a esa persona. Además:
// el enlace /instalar?bajar=1 arranca la descarga del ZIP solo, el botón de
// copiar copia de verdad, el perfil de Apple (.mobileconfig) viaja con su
// MIME exacto, y Chromium real CARGA la extensión desde el ZIP descargado --
// si el paquete que va a la Web Store estuviera roto, se rompe acá primero.
//
// Requiere: pruebas/serve_csp.js corriendo (puerto 4174) sobre un build hecho
// con VITE_SERVER_URL=http://localhost:4001. Correr bajo xvfb-run.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const EXT = path.resolve(__dirname, "../extension");
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

(async () => {
  // ═══════ 1. El ZIP que sirve la web ═══════
  console.log("\n── 1. El ZIP de la extensión ──");
  const res = await fetch(`${B}/unify-extension.zip`);
  check("la web sirve /unify-extension.zip", res.status === 200, `HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  check("es un ZIP de verdad (firma PK)", zip.subarray(0, 2).toString() === "PK");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unify-zip-"));
  const zipPath = path.join(tmp, "ext.zip");
  fs.writeFileSync(zipPath, zip);
  const desem = path.join(tmp, "ext");
  execFileSync("python3", ["-m", "zipfile", "-e", zipPath, desem]);

  // La versión esperada sale del REPO, no de un número pegado acá: si el
  // manifest sube de versión, la prueba sigue afirmando lo que importa (que
  // el ZIP publicado ES la extensión del repositorio, con sus íconos).
  const versionRepo = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../extension/manifest.json"), "utf8")
  ).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(desem, "manifest.json"), "utf8"));
  check("manifest v4 con los íconos que exige la Web Store",
    manifest.version === versionRepo && manifest.icons?.["128"] === "icons/128.png",
    `zip=${manifest.version} repo=${versionRepo}`);
  check("los tres íconos están y pesan algo",
    [16, 48, 128].every((s) => fs.existsSync(path.join(desem, "icons", `${s}.png`)) && fs.statSync(path.join(desem, "icons", `${s}.png`)).size > 200));
  check("las capturas de la ficha (store/) NO viajan en el paquete",
    !fs.existsSync(path.join(desem, "store")));
  const esperados = ["background.js", "content.js", "prompt-injector.js", "offscreen.js", "offscreen.html", "popup.html", "popup.js", "auth-sync.js", "panel.css", "shadow.css"];
  check("contenido byte a byte igual al repositorio",
    esperados.every((f) => fs.readFileSync(path.join(desem, f)).equals(fs.readFileSync(path.join(EXT, f)))));
  // El paquete de la tienda NO puede pedir permisos de desarrollo: la Web
  // Store rechaza versiones con permisos innecesarios, y localhost lo es.
  check("el manifest del paquete no pide orígenes de desarrollo",
    !/localhost|taller-0\.vercel\.app/.test(JSON.stringify(manifest)) &&
    manifest.host_permissions.includes("https://meet.google.com/*"));

  // ═══════ 2. Chromium CARGA la extensión desde el ZIP descargado ═══════
  console.log("\n── 2. El paquete carga en Chromium real ──");
  {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unify-prof-"));
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
      headless: false,
      args: ["--no-sandbox", "--no-proxy-server", `--disable-extensions-except=${desem}`, `--load-extension=${desem}`],
    });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
    check("el service worker arranca desde el paquete del ZIP", Boolean(sw));
    await ctx.close();
  }

  const browser = await chromium.launch({ args: ["--no-sandbox", "--no-proxy-server"] });
  const errs = [];
  const abrir = async (ua, url, permisos = []) => {
    const ctx = await browser.newContext({ userAgent: ua, acceptDownloads: true });
    if (permisos.length) await ctx.grantPermissions(permisos, { origin: B });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    await page.goto(url, { waitUntil: "networkidle" });
    return { ctx, page };
  };
  const texto = (page) => page.evaluate(() => document.body.innerText);

  // ═══════ 3. WINDOWS: pasos de Windows + descarga sola + copiar ═══════
  console.log("\n── 3. Como Windows ──");
  {
    const { ctx, page } = await abrir(UA.windows, `${B}/instalar`, ["clipboard-read", "clipboard-write"]);
    const t = await texto(page);
    check("detecta Windows y lo dice", /estás en Windows/.test(t));
    // Lección de la vida real: el .bat como camino principal hacía saltar los
    // avisos de seguridad de Edge/SmartScreen en cadena y abría una terminal.
    // El camino principal es el ZIP: sin terminal, sin sustos.
    check("ofrece el ZIP como camino principal (sin terminal ni avisos)",
      (await page.locator('a[href="/unify-extension.zip"][download]').count()) >= 1 &&
      /sin terminal ni avisos de seguridad/i.test(t));
    check("con los cuatro pasos claros (Extraer todo → extensiones → cargar)",
      /Extraer todo/.test(t) && /Modo de desarrollador/.test(t) && /Cargar descomprimida/.test(t));
    check("el .bat queda como alternativa CON la advertencia dicha de antemano",
      (await page.locator('a[href="/instalar-unify.bat"]').count()) === 1 &&
      /avisos de seguridad/i.test(t) && /Bloc de notas/.test(t));
    check("NO muestra los pasos de Mac", !/Terminal \(/.test(t) && !/Agregar al Dock/.test(t));
    check("muestra el enlace para compartir con ?bajar=1", /instalar\?bajar=1/.test(t));

    // El enlace mágico, en una página virgen: es el caso real (a quien le
    // comparten /instalar?bajar=1, lo abre y ya). La pestaña se trae al
    // frente porque Chromium DIFIERE las descargas automáticas de pestañas en
    // segundo plano -- y la de una persona real está visible.
    const page2 = await ctx.newPage();
    page2.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const dl = new Promise((res2) => page2.once("download", res2));
    await page2.goto(`${B}/instalar?bajar=1`, { waitUntil: "domcontentloaded" });
    await page2.bringToFront();
    const descarga = await Promise.race([dl, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    check("abrir /instalar?bajar=1 en Windows descarga el ZIP solo (nunca más el .bat)",
      Boolean(descarga) && descarga.suggestedFilename() === "unify-extension.zip",
      descarga?.suggestedFilename() ?? "no hubo descarga");
    await page2.waitForTimeout(600);
    check("y la página avisa que la descarga ya arrancó", /descarga.*arrancó sola/i.test(await texto(page2)));
    await page2.close();

    // chrome://extensions es un botón que copia al tocarlo (Chrome no deja
    // que una página navegue ahí).
    await page.bringToFront();
    await page.locator("button", { hasText: "chrome://extensions" }).first().click();
    await page.waitForTimeout(400);
    const porta = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check("tocar chrome://extensions lo deja en el portapapeles", porta === "chrome://extensions", porta);
    await ctx.close();
  }

  // ═══════ 3b. EDGE en Windows: sus URLs y sus pasos, no los de Chrome ═══════
  console.log("\n── 3b. Como Edge en Windows ──");
  {
    const { ctx, page } = await abrir(UA.edge, `${B}/instalar`, ["clipboard-read", "clipboard-write"]);
    const t = await texto(page);
    check("detecta Edge y lo dice", /estás en Edge/.test(t));
    check("con el Modo de desarrollador donde Edge lo tiene (a la izquierda)",
      /panel de la izquierda/.test(t));
    check("NO ofrece chrome://extensions a alguien de Edge",
      (await page.locator("button", { hasText: "chrome://extensions" }).count()) === 0);
    await page.locator("button", { hasText: "edge://extensions" }).first().click();
    await page.waitForTimeout(400);
    const porta = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check("tocar edge://extensions lo deja en el portapapeles", porta === "edge://extensions", porta);
    await ctx.close();
  }

  // ═══════ 4. MAC: doble clic, Dock, sin “Extraer todo” ═══════
  console.log("\n── 4. Como Mac ──");
  {
    const { ctx, page } = await abrir(UA.mac, `${B}/instalar`, ["clipboard-read", "clipboard-write"]);
    const t = await texto(page);
    check("detecta Mac y lo dice", /estás en Mac/.test(t));
    check("ofrece el comando de Terminal como camino principal",
      /curl -fsSL https:\/\/www\.unify-meet\.com\/instalar-unify\.command \| bash/.test(t));
    await page.locator("button", { hasText: /^Copiar$/ }).first().click();
    await page.waitForTimeout(400);
    const porta = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check("y el botón lo copia entero", /curl -fsSL .*instalar-unify\.command \| bash/.test(porta), porta.slice(0, 50));
    check("con el script legible antes de correrlo", (await page.locator('a[href="/instalar-unify.command"]').count()) === 1);
    check("la app ofrece Safari → Agregar al Dock", /Agregar al Dock/.test(t));
    check("el ZIP sigue como alternativa manual (doble clic)", /bajar el ZIP/.test(t) && /doble clic/.test(t));
    check("NO muestra los pasos de Windows", !/Extraer todo…/.test(t) && !/SmartScreen|Ejecutar de todas formas/.test(t));
    await ctx.close();
  }

  // ═══════ 5. IPHONE/IPAD: la app por dos caminos; la extensión es de compus ═══════
  console.log("\n── 5. Como iPhone/iPad ──");
  {
    const { ctx, page } = await abrir(UA.iphone, `${B}/instalar`);
    const t = await texto(page);
    check("detecta iPhone/iPad", /estás en iPhone\/iPad/.test(t));
    check("camino A: Compartir → Agregar a inicio", /Agregar a inicio/.test(t));
    check("camino B: instalar CON UN ARCHIVO (perfil de Apple)", /Con un archivo \(perfil de Apple\)/.test(t));
    check("con el botón del perfil y sus pasos de Ajustes",
      (await page.locator('a[href="/unify-ipad.mobileconfig"]').count()) === 1 && /Perfil descargado/.test(t));
    check("dice sin vueltas que un ZIP no instala nada en un iPad", /un ZIP no instala nada en un iPad/.test(t));
    check("las extensiones son de computadoras, dicho claro", /sólo existen en computadoras/.test(t));
    check("y ofrece el enlace para mandarse a la computadora", /instalar\?bajar=1/.test(t));
    check("sin botón de descarga del ZIP en el teléfono", !/Descargar la extensión/.test(t));
    // En el teléfono, abrir ?bajar=1 NO debe disparar ninguna descarga.
    let bajo = false;
    page.on("download", () => { bajo = true; });
    await page.goto(`${B}/instalar?bajar=1`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    check("?bajar=1 en el teléfono no descarga nada", !bajo);
    await ctx.close();
  }

  // ═══════ 6. El botón de instalar la app (cuando el navegador lo ofrece) ═══════
  console.log("\n── 6. Instalar la app con un clic ──");
  {
    const { ctx, page } = await abrir(UA.windows, `${B}/instalar`);
    let prompted = false;
    await page.exposeFunction("unifyPrompted", () => { prompted = true; });
    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = async () => { window.unifyPrompted(); };
      ev.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(500);
    const boton = page.locator("button", { hasText: "Instalar Unify en este dispositivo" });
    check("aparece el botón de UN clic", (await boton.count()) === 1);
    await boton.click();
    await page.waitForTimeout(600);
    check("el clic dispara el prompt real", prompted);
    check("y la confirmación queda a la vista", /quedó instalada/i.test(await texto(page)));
    await ctx.close();
  }

  // ═══════ 6b. Los instaladores de escritorio ═══════
  console.log("\n── 6b. Los instaladores (Windows y Mac) ──");
  {
    const bat = await fetch(`${B}/instalar-unify.bat`);
    check("el .bat de Windows se sirve", bat.status === 200, `HTTP ${bat.status}`);
    const batTxt = Buffer.from(await bat.arrayBuffer()).toString("latin1");
    check("con CRLF (sin eso, cmd.exe hace cualquier cosa)", /\r\n/.test(batTxt));
    check("descarga el ZIP real, descomprime y copia la ruta",
      batTxt.includes("unify-extension.zip") && batTxt.includes("Expand-Archive") && batTxt.includes("Set-Clipboard"));
    check("abre chrome://extensions (o Edge si no hay Chrome)",
      batTxt.includes("chrome://extensions") && batTxt.includes("edge://extensions"));
    check("y es auditable (se anuncia como texto plano)", /Bloc de notas/.test(batTxt));

    const cmd = await fetch(`${B}/instalar-unify.command`);
    check("el .command de Mac se sirve", cmd.status === 200, `HTTP ${cmd.status}`);

    // El de Mac se EJECUTA acá mismo: su núcleo (descargar el ZIP real de la
    // web local, descomprimir, ruta con espacios) corre igual en Linux; lo
    // exclusivo de macOS (pbcopy, open) está protegido con "|| true".
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fakehome-"));
    execFileSync("bash", [path.resolve(__dirname, "../client/public/instalar-unify.command")], {
      env: { ...process.env, UNIFY_BASE: B, HOME: fakeHome },
      stdio: "pipe",
    });
    const manifiesto = path.join(fakeHome, "Library", "Application Support", "Unify", "extension", "manifest.json");
    check("EJECUTADO de verdad: deja la extensión instalada donde dice",
      fs.existsSync(manifiesto) && JSON.parse(fs.readFileSync(manifiesto, "utf8")).version === versionRepo);
  }

  // ═══════ 7. Los archivos de Apple ═══════
  console.log("\n── 7. El perfil de Apple y el ícono de inicio ──");
  {
    const res2 = await fetch(`${B}/unify-ipad.mobileconfig`);
    check("el perfil responde 200", res2.status === 200, `HTTP ${res2.status}`);
    check("con el MIME exacto que Safari exige para instalar",
      res2.headers.get("content-type") === "application/x-apple-aspen-config",
      res2.headers.get("content-type"));
    const cuerpo = Buffer.from(await res2.arrayBuffer()).toString("latin1");
    check("es un plist con el Web Clip de Unify",
      cuerpo.includes("com.apple.webClip.managed") && cuerpo.includes("https://www.unify-meet.com/"));
    check("lleva el ícono adentro (base64 grande)", /<data>[\s\S]{40000,}/.test(cuerpo));
    check("se puede quitar (IsRemovable)", cuerpo.includes("IsRemovable"));

    const icono = await fetch(`${B}/icons/apple-touch-icon.png`);
    check("el apple-touch-icon existe (sin él, 'Agregar a inicio' pone una captura fea)",
      icono.status === 200 && (icono.headers.get("content-type") ?? "").includes("png"));
    const html = await (await fetch(`${B}/`)).text();
    check("y la página lo declara junto a los metas de Apple",
      html.includes('rel="apple-touch-icon"') && html.includes("apple-mobile-web-app-capable"));
  }

  // ═══════ 8. Privacidad + enlace desde el inicio ═══════
  console.log("\n── 8. Privacidad y descubribilidad ──");
  {
    const { ctx, page } = await abrir(UA.windows, `${B}/`);
    check("la página de inicio enlaza /instalar", (await page.locator('a[href="/instalar"]').count()) >= 1);
    check("y tiene el botón de soporte abajo (pie de página)",
      (await page.locator('footer a[href="/soporte"]').count()) === 1 &&
      /Centro de ayuda y contacto/.test(await texto(page)));
    await page.goto(`${B}/privacidad`, { waitUntil: "networkidle" });
    const priv = await texto(page);
    check("/privacidad existe (la exige la Web Store)", /Qué guardamos/.test(priv) && /Anthropic/.test(priv));
    // La "URL de asistencia" de la ficha: tiene que existir y responder lo
    // que la gente pregunta de verdad (instalar, grabar, dónde queda todo).
    await page.goto(`${B}/soporte`, { waitUntil: "networkidle" });
    const sop = await texto(page);
    check("/soporte existe (la URL de asistencia de la ficha)",
      /Ayuda de Unify/.test(sop) && /Cómo instalo/.test(sop) && /hola@unify-meet\.com/.test(sop));
    check("con el teléfono de contacto y su enlace de WhatsApp",
      /11 3025-4522/.test(sop) &&
      (await page.locator('a[href="https://wa.me/5491130254522"]').count()) === 1);
    check("y es honesto con el límite real (la app de escritorio de Zoom)",
      /extensión de navegador no puede/.test(sop));
    await ctx.close();
  }

  check("sin errores de JavaScript en ninguna página", errs.length === 0, errs.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
