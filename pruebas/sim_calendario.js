// El vigilante del calendario, estilo Granola: la app abierta (aunque esté
// minimizada o detrás de otra ventana) te avisa cuando una reunión agendada
// está por empezar -- cartel adentro Y notificación del SISTEMA -- y te deja
// a un toque de entrar con subtítulos, transcripción y grabación.
//
// Los endpoints de calendario se estuban con rutas de Playwright (conectar
// un Outlook real acá es imposible); lo que se prueba es TODO lo nuestro:
// el sondeo, el cartel, la cuenta regresiva, la notificación del sistema
// cuando la app no está a la vista, y el pedido de permiso una sola vez.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try { body = JSON.parse(await res.text()); } catch { /* sin json */ }
  return { status: res.status, body };
}
const json = (b) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

(async () => {
  // Una cuenta real (el vigilante sólo corre con sesión iniciada).
  const email = `cal${Date.now()}@test.com`;
  const reg = await api("/api/auth/register", json({ email, password: "melon42Trueno", name: "Cala" }));
  check("hay cuenta para el vigilante", Boolean(reg.body?.token), `HTTP ${reg.status}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  // Sin service worker: con SW activo, las rutas interceptadas de Playwright
  // rompen la SEGUNDA navegación (root vacío) -- la misma trampa que cazó
  // sim_movil. Acá el SW no aporta nada a lo que se prueba.
  const ctx = await browser.newContext({ permissions: ["notifications"], serviceWorkers: "block" });

  // El calendario, estubado: un evento con enlace de Zoom que empieza YA.
  const evento = {
    id: "ev-directorio-1",
    subject: "Reunión de Directorio",
    start: new Date(Date.now() + 60_000).toISOString(),
    joinUrl: "https://us05web.zoom.us/j/91234567890",
  };
  await ctx.route("**/api/calendar/upcoming*", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ configured: true, connected: true, events: [evento] }) })
  );

  // Notification del sistema, espiada: se registra cada construcción, y la
  // app se hace pasar por MINIMIZADA (visibilityState "hidden") -- que es
  // exactamente el caso que la notificación existe para cubrir.
  await ctx.addInitScript(() => {
    window.__notis = [];
    class FakeNotification {
      constructor(titulo, opts) {
        window.__notis.push({ titulo, cuerpo: opts?.body ?? "", tag: opts?.tag ?? "" });
      }
      close() { /* nada */ }
      static requestPermission() {
        window.__notis.push({ pedido: true });
        return Promise.resolve("granted");
      }
    }
    FakeNotification.permission = "granted";
    // @ts-ignore
    window.Notification = FakeNotification;
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    Object.defineProperty(document, "hidden", { get: () => true });
    document.hasFocus = () => false;
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  await p.goto(`${B}/historial`, { waitUntil: "domcontentloaded" });
  await p.evaluate((t) => localStorage.setItem("encuentro_token", t), reg.body.token);
  await p.goto(`${B}/historial`, { waitUntil: "networkidle" });
  await p.waitForTimeout(3000);

  // ── 1. El cartel de adentro ──
  const cuerpo = (await p.locator("body").textContent()) || "";
  check("el cartel de la reunión agendada aparece (en cualquier página)",
    /Tenés una reunión ahora/i.test(cuerpo) && /Reunión de Directorio/i.test(cuerpo));
  check("con la cuenta regresiva corriendo", /Empiezo a preparar la grabación en/i.test(cuerpo));

  // ── 2. La notificación del SISTEMA (la app estaba "minimizada") ──
  const notis = await p.evaluate(() => window.__notis ?? []);
  const delSistema = notis.find((n) => n.titulo);
  check("la notificación del sistema salió (Unify estaba detrás)",
    Boolean(delSistema), JSON.stringify(notis).slice(0, 80));
  check("y nombra la reunión con lo que Unify puede hacer",
    /Reunión de Directorio/.test(delSistema?.cuerpo ?? "") && /subtítulos/.test(delSistema?.cuerpo ?? ""),
    delSistema?.cuerpo?.slice(0, 60));

  // ── 3. "Ahora no" corta la cuenta y no re-insiste ──
  await p.getByRole("button", { name: /Ahora no/i }).first().click();
  await p.waitForTimeout(1500);
  check("«Ahora no» retira el cartel",
    !/Tenés una reunión ahora/i.test((await p.locator("body").textContent()) || ""));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  check("y tras recargar tampoco insiste con el MISMO evento",
    !/Tenés una reunión ahora/i.test((await p.locator("body").textContent()) || ""));

  // ── 4. La cuenta regresiva termina en la reunión lista para grabar ──
  const evento2 = { ...evento, id: "ev-directorio-2", subject: "Sprint semanal" };
  await ctx.route("**/api/calendar/upcoming*", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ configured: true, connected: true, events: [evento2] }) })
  );
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(5000);
  check("un evento NUEVO sí vuelve a avisar",
    /Sprint semanal/i.test((await p.locator("body").textContent()) || ""),
    ((await p.locator("body").textContent()) || "").slice(0, 90).replace(/\s+/g, " "));
  await p.waitForTimeout(9000); // la cuenta regresiva de 8 s se agota sola
  check("sin respuesta, la cuenta termina y lleva a la reunión detectada",
    p.url().includes("/externa"), p.url());
  check("con el enlace del evento puesto", decodeURIComponent(p.url()).includes("zoom.us"));

  // ── 5. El permiso de avisos se pidió UNA sola vez ──
  const pedidos = (await p.evaluate(() => (window.__notis ?? []).filter((n) => n.pedido).length));
  check("el permiso de notificaciones no se pide en bucle", pedidos <= 1, `pedidos=${pedidos}`);

  check("sin errores de JavaScript en todo el flujo", errs.length === 0, errs.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
