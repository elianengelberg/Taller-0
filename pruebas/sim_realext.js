// Carga la EXTENSIÓN REAL en Chromium real (sin stubs de chrome.*) y la prueba
// contra un Meet simulado que reescribe los subtítulos como lo hace Google.
// Se prueba una COPIA de la extensión cuyo manifest apunta también a localhost;
// el manifest que se publica no se toca.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const SRC = "/home/user/Taller-0/extension";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Meet falso</title></head>
<body style="margin:0;background:#202124;height:100vh">
  <button aria-label="Salir de la llamada">Salir</button>
  <button aria-label="Mostrar a todos (3)">Personas</button>
  <div data-is-muted="false" aria-label="Desactivar micrófono"></div>
  <div data-is-muted="false" aria-label="Desactivar cámara"></div>
  <div role="region" aria-label="Subtítulos" id="caps"></div>
  <script>
    // Capturamos lo que la extensión envía al backend de Unify.
    window.__posted = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/transcript")) {
        try { window.__posted.push(JSON.parse(opts.body)); } catch {}
        return new Response(JSON.stringify({ ok: true, dbId: "fake" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/session")) {
        return new Response(JSON.stringify({ dbId: "fake", transcript: [], participants: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/translate")) {
        return new Response(JSON.stringify({ translatedText: "TRADUCIDO" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return realFetch(url, opts);
    };
    const caps = document.getElementById("caps");
    window.__say = async (speaker, full) => {
      const row = document.createElement("div");
      row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
      caps.appendChild(row);
      row.querySelector(".n").textContent = speaker;
      const t = row.querySelector(".t");
      const words = full.split(" ");
      for (let i = 1; i <= words.length; i++) {
        t.textContent = words.slice(0, i).join(" ");
        await new Promise((r) => setTimeout(r, 30));
      }
    };
  </script>
</body></html>`;

(async () => {
  // --- Copia de la extensión con el manifest apuntando también a localhost ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unify-ext-"));
  // Copia RECURSIVA: el manifest declara icons/16.png etc., y si la copia
  // pierde la carpeta icons/, Chrome muestra el modal "Failed to load
  // extension" y el navegador nunca llega a estar listo (Playwright revienta
  // por timeout de arranque, sin una sola prueba corrida).
  fs.cpSync(SRC, dir, { recursive: true });
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const LOCAL = "http://localhost:4189/*";
  man.host_permissions.push(LOCAL);
  man.content_scripts[0].matches.push(LOCAL);
  man.web_accessible_resources.forEach((r) => r.matches.push(LOCAL));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(man, null, 2));

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(4189, r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unify-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: false, // las extensiones necesitan modo con ventana (corre bajo xvfb)
    args: [
      "--no-sandbox",
      // El entorno define HTTPS_PROXY y Chromium lo hereda; acá todo vive en
      // localhost y el proxy sólo aporta cuelgues en el arranque. Directo.
      "--no-proxy-server",
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  // El service worker de MV3 confirma que la extensión cargó de verdad.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("la extensión CARGA en Chromium real (service worker activo)", Boolean(sw), sw ? sw.url().split("/").pop() : "no arrancó");

  // El content script vive en un mundo aislado: hay que interceptar en el
  // navegador, no pisando window.fetch de la página.
  const posted = [];
  await ctx.route("**/api/meet-bridge/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/transcript")) {
      try { posted.push(JSON.parse(route.request().postData() || "{}")); } catch {}
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, dbId: "fake" }) });
    }
    if (url.endsWith("/session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dbId: "fake", transcript: [], participants: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await ctx.route("**/api/translate", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "we need to approve the budget" }) })
  );

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  await page.goto("http://localhost:4189/abc-defg-hij", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  check("inyecta el panel con Shadow DOM", (await page.locator("#unify-root").count()) > 0);
  const shadowOk = await page.evaluate(() => Boolean(document.getElementById("unify-root")?.shadowRoot));
  check("el panel usa Shadow DOM aislado (no lo rompe el CSS de Meet)", shadowOk);
  check("badge de estado presente", (await page.locator(".badge").count()) > 0);
  check("cajón lateral con 3 pestañas", (await page.locator(".drawer .tab").count()) === 3);

  // --- Conversación real de 3 personas ---
  await page.evaluate(() => window.__say("Ana García", "buenos días equipo, arrancamos con el presupuesto"));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__say("Bruno Pérez", "yo tengo los números del trimestre listos"));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__say("Carolina Díaz", "diseño necesita dos semanas más"));
  await page.waitForTimeout(2400);

  const speakers = [...new Set(posted.map((p) => p.speaker))];
  check("transcribe a TODOS los participantes", speakers.length === 3, speakers.join(" | "));
  check("una frase por persona, sin duplicados", posted.length === 3, `enviadas=${posted.length}`);
  check("las frases salen completas", posted.every((p) => p.text.split(" ").length >= 5),
    posted.map((p) => `"${p.text}"`).join(" / "));

  const subs = await page.locator(".subs").textContent();
  check("los subtítulos se ven sobre el video", /Carolina|diseño/.test(subs || ""), (subs || "").replace(/\s+/g, " ").slice(0, 70));

  const stream = await page.locator(".stream").textContent();
  check("la transcripción del panel muestra a los tres", ["Ana", "Bruno", "Carolina"].every((n) => (stream || "").includes(n)));

  check("sin errores de JavaScript", errs.length === 0, errs[0] || "");

  await ctx.close();
  server.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
