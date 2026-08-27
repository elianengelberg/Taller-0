// La app de escritorio, probada sin Windows y sin Zoom.
//
// El circuito completo que cubre: la app detecta que Zoom entró a una reunión
// (detector), muestra el cartel "¿querés grabarla?" con el sí automático
// (cartel.html), publica el estado en el puente local (puente.js), la web se
// abre en modo escritorio (/externa?origen=escritorio), entra sola al
// companion "Zoom (app de escritorio)" y, cuando el puente dice que la reunión
// terminó, corta y saca a la persona (invitado: aviso de guardar).
//
// Lo ÚNICO que no se puede probar acá es Windows mismo (tasklist/CptHost) y el
// binario de Electron: esa lógica quedó aislada en sonda/spawn justamente para
// que todo lo demás se pruebe de verdad.
//
// Requiere: build servido en 4174 (serve_csp con el vercel.json actual, que
// permite 127.0.0.1:47125 en connect-src) y el servidor real en 4001.
const http = require("http");
const path = require("path");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { crearDetector } = require("../desktop/detector");
const { crearPuente, PUERTO_PUENTE } = require("../desktop/puente");

const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ═══════ 1. El detector: dos lecturas seguidas antes de avisar ═══════
  console.log("\n── 1. Detector de reuniones de Zoom ──");
  {
    let lectura = false;
    let entradas = 0;
    let salidas = 0;
    const det = crearDetector({
      sonda: () => Promise.resolve(lectura),
      alEntrar: () => entradas++,
      alSalir: () => salidas++,
      intervaloMs: 60_000, // el reloj no juega: se avanza a mano con _tick
    });
    await det._tick(); await det._tick();
    check("sin Zoom no pasa nada", entradas === 0 && salidas === 0);
    lectura = true;
    await det._tick();
    check("UNA lectura de reunión todavía no dispara el cartel", entradas === 0);
    await det._tick();
    check("la segunda seguida sí: reunión confirmada", entradas === 1 && det.enReunion === true);
    await det._tick();
    check("y no vuelve a disparar mientras siga la misma reunión", entradas === 1);
    lectura = false;
    await det._tick();
    check("una lectura de 'terminó' tampoco corta sola", salidas === 0);
    await det._tick();
    check("la segunda confirma el final", salidas === 1 && det.enReunion === false);
    // Una sonda que explota cuenta como "no hay reunión", nunca como crash.
    const det2 = crearDetector({
      sonda: () => Promise.reject(new Error("tasklist roto")),
      alEntrar: () => {},
      alSalir: () => {},
      intervaloMs: 60_000,
    });
    await det2._tick(); await det2._tick();
    check("una sonda rota no tira el vigía ni inventa reuniones", det2.enReunion === false);
    det.detener(); det2.detener();
  }

  // ═══════ 2. El puente local ═══════
  console.log("\n── 2. Puente 127.0.0.1:47125 ──");
  {
    const puente = crearPuente();
    await puente.listo;
    const leer = () =>
      new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PUERTO_PUENTE}/estado`, (res) => {
          let cuerpo = "";
          res.on("data", (c) => (cuerpo += c));
          res.on("end", () => resolve({ res, dato: JSON.parse(cuerpo) }));
        }).on("error", reject);
      });
    let { res, dato } = await leer();
    check("arranca diciendo que NO hay reunión", dato.enReunion === false && dato.app === "unify-escritorio");
    check("con CORS abierto (la página https puede leerlo)", res.headers["access-control-allow-origin"] === "*");
    check("y sin caché (el dato es de ahora)", /no-store/.test(res.headers["cache-control"] || ""));
    puente.fijarEstado(true);
    ({ dato } = await leer());
    check("al fijar 'en reunión' la lectura cambia", dato.enReunion === true);
    const otra = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${PUERTO_PUENTE}/otra-cosa`, (r) => resolve(r.statusCode));
    });
    check("cualquier otra ruta es 404", otra === 404);
    await puente.cerrar();
  }

  // ═══════ 3. El cartel: sí automático y botones ═══════
  console.log("\n── 3. El cartel '¿querés grabarla?' ──");
  // Micrófono falso: la grabación automática (modo sólo audio) necesita un
  // getUserMedia que responda sin diálogo.
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--no-proxy-server",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  {
    const cartelUrl = "file://" + path.join(__dirname, "..", "desktop", "cartel.html");
    const p = await browser.newPage();
    await p.goto(`${cartelUrl}?seg=1`);
    check("el cartel dice lo que tiene que decir",
      (await p.getByText(/te estás uniendo a una reunión/i).count()) > 0 &&
      (await p.getByText(/¿Querés grabarla\?/i).count()) > 0);
    check("y avisa que sin respuesta graba igual", (await p.getByText(/Si no elegís nada/i).count()) > 0);
    await dormir(1600);
    check("sin tocar nada, al vencer la cuenta es un SÍ",
      (await p.evaluate(() => window.__respuesta)) === "si");
    await p.close();

    const p2 = await browser.newPage();
    await p2.goto(`${cartelUrl}?seg=1`);
    await p2.click("#no");
    await dormir(1400);
    check("'Ahora no' gana aunque después venza la cuenta",
      (await p2.evaluate(() => window.__respuesta)) === "no");
    await p2.close();

    const p3 = await browser.newPage();
    await p3.goto(`${cartelUrl}?seg=8`);
    await p3.click("#si");
    check("'Sí, grabala' responde al toque, sin esperar",
      (await p3.evaluate(() => window.__respuesta)) === "si");
    await p3.close();
  }

  // ═══════ 4. El circuito web completo, con un puente de mentira ═══════
  console.log("\n── 4. La barra acompañante en modo escritorio ──");
  {
    // El puente lo actúa la prueba: primero "en reunión", después "terminó".
    let enReunion = true;
    const stub = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ app: "unify-escritorio", enReunion }));
    });
    await new Promise((r) => stub.listen(PUERTO_PUENTE, "127.0.0.1", r));

    const ctx = await browser.newContext({
      viewport: { width: 1100, height: 750 },
      permissions: ["microphone"],
    });
    const errs = [];
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

    await p.goto(`${B}/externa?origen=escritorio&sala=prueba-cartel-123`);
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    check("el deep link de la app entra DERECHO a la barra (sin formularios)",
      p.url().includes("/externa/reunion"), p.url());
    await p.getByText("Zoom (app de escritorio)").first().waitFor({ timeout: 15000 }).catch(() => {});
    check("la barra se presenta como la reunión de Zoom de la app",
      (await p.getByText("Zoom (app de escritorio)").count()) > 0);
    // Mientras el puente diga "en reunión", la barra se queda.
    await dormir(6000);
    check("mientras Zoom siga, la barra no se va sola", p.url().includes("/externa/reunion"));

    // Zoom cerró: la app baja el estado y la barra tiene que cerrar el círculo.
    enReunion = false;
    const aviso = p.getByText("¿Guardar esta reunión?");
    await aviso.waitFor({ timeout: 20000 }).catch(() => {});
    check("cuando la app avisa que terminó, la barra corta y ofrece guardar (invitado)",
      (await aviso.count()) > 0);
    check("sin errores de JavaScript en todo el circuito", errs.length === 0, errs[0] || "");
    await ctx.close();
    await new Promise((r) => stub.close(r));
  }

  // ═══════ 5. Puente caído = no hay quien vigile: también se corta ═══════
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 750 }, permissions: ["microphone"] });
    const p = await ctx.newPage();
    await p.goto(`${B}/externa?origen=escritorio&sala=sin-puente-9`);
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    const aviso = p.getByText("¿Guardar esta reunión?");
    await aviso.waitFor({ timeout: 20000 }).catch(() => {});
    check("si el puente no está (la app se cerró), la barra no queda grabando para siempre",
      (await aviso.count()) > 0);
    await ctx.close();
  }

  // ═══════ 6. El flujo normal de /externa no se contagia ═══════
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${B}/externa`);
    await dormir(1500);
    check("/externa sin origen=escritorio sigue siendo el formulario de siempre",
      p.url().includes("/externa") && !p.url().includes("/reunion") &&
      (await p.getByText(/pegalo acá|enlace/i).count()) > 0);
    const flag = await p.evaluate(() => sessionStorage.getItem("unify_escritorio"));
    check("y no queda ninguna marca de modo escritorio", flag !== "1");
    await ctx.close();
  }

  await browser.close();

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
