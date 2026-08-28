// La malla WebRTC con DOS participantes reales en la misma reunión nativa.
//
// Hasta ahora ninguna suite establecía una conexión WebRTC de verdad: todas
// entraban de a una persona. Acá dos navegadores se ven y se escuchan, que es
// lo que hay que proteger al tocar useWebRTC.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io: sio } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IGNORABLE = /fonts\.g|favicon|ERR_ABORTED|ResizeObserver|Download the React/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Recurso externo cortado por el sandbox (proxy 502/404): no es del producto.
    if (/Failed to load resource/i.test(m.text()) && !(m.location?.().url || "").includes("localhost")) return;
    const t = `${m.text()} ${m.location?.().url || ""}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 110)}`);
  });
}

// Cuántos <video> tienen un stream REMOTO con pistas vivas.
async function remoteVideos(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const v of document.querySelectorAll("video")) {
      const s = v.srcObject;
      if (!s || typeof s.getTracks !== "function") continue;
      // El propio no cuenta: se distingue porque está silenciado en el DOM.
      if (v.muted) continue;
      if (s.getTracks().some((t) => t.readyState === "live")) n++;
    }
    return n;
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
    await c.route("**fonts.g**", (r) => r.abort());
    return c;
  };

  const ctxA = await mk();
  const ctxB = await mk();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const bagA = [], bagB = [];
  watch(a, bagA); watch(b, bagB);

  // La reunión se crea por socket y ese cliente se va enseguida: así el test
  // tiene el código sin depender de dónde lo muestre la interfaz, y los dos
  // navegadores entran en igualdad de condiciones.
  const creator = sio(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { creator.on("connect", r); creator.on("connect_error", x); });
  const created = await new Promise((res) => creator.timeout(8000).emit("create-meeting",
    { hostName: "Semilla", hostLanguage: "es-AR", roles: [] }, (e, r) => res(r)));
  const code = created?.meeting?.id;
  check("se crea la reunión y hay código", Boolean(code), String(code));
  if (!code) { creator.disconnect(); await browser.close(); process.exit(1); }
  creator.disconnect();
  await sleep(700);

  for (const [page, name] of [[a, "Ana"], [b, "Bruno"]]) {
    await page.goto(`${B}/unirse/${code}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Tu nombre/i).fill(name);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Unirme|Entrar/i }).last().click();
    await page.waitForTimeout(4500);
  }
  check("A entra a la reunión", a.url().includes("/reunion"), a.url());
  check("B entra a la misma reunión", b.url().includes("/reunion"), b.url());

  // Esperar a que la malla se establezca.
  let ra = 0, rb = 0;
  for (let i = 0; i < 12; i++) {
    ra = await remoteVideos(a);
    rb = await remoteVideos(b);
    if (ra > 0 && rb > 0) break;
    await sleep(1500);
  }
  check("A recibe el video de B por WebRTC", ra > 0, `remotos en A=${ra}`);
  check("B recibe el video de A por WebRTC", rb > 0, `remotos en B=${rb}`);

  // Cada uno ve al otro en la lista de participantes.
  const textA = (await a.locator("body").textContent()) || "";
  const textB = (await b.locator("body").textContent()) || "";
  check("A ve a Bruno en la reunión", textA.includes("Bruno"));
  check("B ve a Ana en la reunión", textB.includes("Ana"));

  // El chat viaja entre los dos.
  const chatBtn = a.getByRole("button", { name: /Chat/i }).first();
  if (await chatBtn.count()) {
    await chatBtn.click();
    await a.waitForTimeout(600);
    const input = a.getByPlaceholder(/mensaje|Escribí/i).first();
    if (await input.count()) {
      await input.fill("hola bruno, me escuchas");
      await input.press("Enter");
      await sleep(2200);
    }
  }
  const chatB = a.getByRole("button", { name: /Chat/i }).first();
  if (await chatB.count()) { /* ya abierto en A */ }
  const bChat = b.getByRole("button", { name: /Chat/i }).first();
  if (await bChat.count()) { await bChat.click(); await b.waitForTimeout(900); }
  check("el chat de A le llega a B",
    ((await b.locator("body").textContent()) || "").includes("me escuchas"));

  // B se va: A tiene que soltar su conexión sin romperse.
  const salir = b.getByRole("button", { name: /Salir/i }).first();
  if (await salir.count()) { await salir.click(); await sleep(1200); }
  const prompt = b.getByText(/¿Guardar esta reunión\?/i);
  if (await prompt.count()) {
    for (const btn of await b.getByRole("button").all()) {
      const t = (await btn.textContent()) || "";
      if (/sin guardar|Seguir|No,|Descartar/i.test(t)) { await btn.click(); break; }
    }
  }
  await sleep(3000);
  check("cuando B se va, A suelta su video", (await remoteVideos(a)) === 0, `remotos en A=${await remoteVideos(a)}`);
  check("A sigue en la reunión y funcionando", a.url().includes("/reunion"));

  check("sin errores de JS en A", bagA.length === 0, bagA.slice(0, 2).join(" | "));
  check("sin errores de JS en B", bagB.length === 0, bagB.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
