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
// Un elemento que TIENE que estar: si no está, es FAIL (no un salto en
// silencio que deja la suite en verde con la pantalla rota).
const exigir = async (loc, nombre) => {
  const n = await loc.count().catch(() => 0);
  if (n > 0) return true;
  check(nombre, false, "no está en la pantalla");
  return false;
};
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
  if (await exigir(chatBtn, "A tiene el botón de Chat")) {
    await chatBtn.click();
    await a.waitForTimeout(600);
    const input = a.getByPlaceholder(/mensaje|Escribí/i).first();
    if (await exigir(input, "el chat tiene el campo para escribir")) {
      await input.fill("hola bruno, me escuchas");
      await input.press("Enter");
      await sleep(2200);
    }
  }
  const chatB = a.getByRole("button", { name: /Chat/i }).first();
  if (await chatB.count()) { /* ya abierto en A */ }
  const bChat = b.getByRole("button", { name: /Chat/i }).first();
  if (await exigir(bChat, "B tiene el botón de Chat")) { await bChat.click(); await b.waitForTimeout(900); }
  check("el chat de A le llega a B",
    ((await b.locator("body").textContent()) || "").includes("me escuchas"));

  // B se va: A tiene que soltar su conexión sin romperse.
  const salir = b.getByRole("button", { name: /Salir/i }).first();
  if (await exigir(salir, "B tiene el botón Salir")) { await salir.click(); await sleep(1200); }
  const prompt = b.getByText(/¿Guardar esta reunión\?/i);
  if (await prompt.count()) {
    // Por NOMBRE, no por índice: recorrer la lista de botones y clicar el
    // enésimo fallaba si mientras tanto se iba un botón transitorio (un
    // aviso, un «Reintentar») y ese índice dejaba de existir.
    const no = b.getByRole("button", { name: /sin guardar|Seguir|No, gracias|Descartar/i }).first();
    if (await exigir(no, "el diálogo de guardar tiene su «No, gracias»")) await no.click();
  }
  await sleep(3000);
  check("cuando B se va, A suelta su video", (await remoteVideos(a)) === 0, `remotos en A=${await remoteVideos(a)}`);
  check("A sigue en la reunión y funcionando", a.url().includes("/reunion"));

  check("sin errores de JS en A", bagA.length === 0, bagA.slice(0, 2).join(" | "));
  check("sin errores de JS en B", bagB.length === 0, bagB.slice(0, 2).join(" | "));

  // ── LAS SALIDAS LLEGAN A DESTINO ──
  // Regresión de react-router 7: leaveMeeting() vacía el draft y el router
  // pinta la pantalla nueva en una transición, así que la reunión llegaba a
  // re-renderizarse SIN draft antes de irse y su guardia ("sin draft → al
  // inicio") pisaba el destino real: la invitada que quería GUARDAR no
  // llegaba a iniciar sesión, y el expulsado llegaba al inicio sin el aviso.
  const anfitriona = sio(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { anfitriona.on("connect", r); anfitriona.on("connect_error", x); });
  const entrantes = [];
  anfitriona.on("participant-joined", (p) => entrantes.push(p?.participant ?? p));
  const creada2 = await new Promise((res) => anfitriona.timeout(8000).emit("create-meeting",
    { hostName: "Anfitriona", hostLanguage: "es-AR", roles: [] }, (e, r) => res(r)));
  const code2 = creada2?.meeting?.id;
  check("se crea la segunda reunión (la anfitriona se queda, por socket)", Boolean(code2), String(code2));
  const ctxC = await mk(), ctxD = await mk();
  const c = await ctxC.newPage(), d = await ctxD.newPage();
  const bagC = [], bagD = [];
  watch(c, bagC); watch(d, bagD);
  for (const [page, name] of [[c, "Carla"], [d, "Diego"]]) {
    await page.goto(`${B}/unirse/${code2}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Tu nombre/i).fill(name);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Unirme|Entrar/i }).last().click();
    await page.waitForURL(/\/reunion/, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  check("Carla y Diego entran como invitados", c.url().includes("/reunion") && d.url().includes("/reunion"), `${c.url()} ${d.url()}`);

  // 1) Carla se va y quiere GUARDAR la reunión en una cuenta: tiene que
  //    llegar a /ingresar (que después reclama la reunión), no al inicio.
  const salirC = c.getByRole("button", { name: /Salir/i }).first();
  if (await exigir(salirC, "Carla tiene el botón Salir")) await salirC.click();
  const guardar = c.getByRole("button", { name: /Guardar \(iniciar sesión\)/i }).first();
  await guardar.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
  if (await exigir(guardar, "al salir, la invitada puede elegir «Guardar (iniciar sesión)»")) {
    await guardar.click();
    await c.waitForURL(/\/ingresar/, { timeout: 8000 }).catch(() => {});
    await sleep(1200);
  }
  check("«Guardar» la lleva a iniciar sesión (no la devuelve al inicio)",
    new URL(c.url()).pathname === "/ingresar", c.url());

  // 2) La anfitriona expulsa a Diego: tiene que llegar al INICIO con el aviso
  //    de por qué (sin el aviso parece que la app se cayó).
  const diego = entrantes.find((p) => p?.name === "Diego");
  check("la anfitriona vio entrar a Diego", Boolean(diego?.id), JSON.stringify(entrantes).slice(0, 120));
  const echado = await new Promise((res) => anfitriona.timeout(6000).emit("moderate",
    { action: "kick", targetId: diego?.id }, (e, r) => res(r ?? { ok: false })));
  check("la anfitriona puede expulsarlo", echado?.ok === true, JSON.stringify(echado));
  await d.waitForURL((u) => u.pathname === "/", { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  const cuerpoD = (await d.locator("body").textContent()) || "";
  check("el expulsado llega al inicio", new URL(d.url()).pathname === "/", d.url());
  check("y ve POR QUÉ salió (el aviso de la expulsión)", /te quitó de la reunión/i.test(cuerpoD), cuerpoD.slice(0, 160).replace(/\s+/g, " "));
  check("sin errores de JS en Carla y Diego", bagC.length === 0 && bagD.length === 0, (bagC[0] || bagD[0] || ""));
  anfitriona.disconnect();

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
