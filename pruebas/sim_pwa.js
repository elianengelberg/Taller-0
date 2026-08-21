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

  check("sin errores de JavaScript", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 300)); process.exit(1); });
