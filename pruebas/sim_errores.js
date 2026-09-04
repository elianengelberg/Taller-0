// Cacería de errores en reuniones externas: recorre el flujo completo de cada
// plataforma y registra TODO lo que se rompa -- errores de JavaScript, errores
// de consola, pedidos de red fallidos y estados colgados.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
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
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const meetCode = () => `${rnd(3)}-${rnd(4)}-${rnd(3)}`;

// Ruido esperable que NO es un error del producto.
const IGNORABLE = /fonts\.g|external_api|favicon|ERR_ABORTED|net::ERR_FAILED.*(jit\.si|zoom|teams)|Failed to load resource.*(jit\.si|zoom|teams)|ResizeObserver/i;

function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // El texto de un fallo de red no incluye la URL: viene en location().
    const url = m.location?.().url || "";
    const t = `${m.text()} ${url}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 110)} @ ${url.slice(0, 80)}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (IGNORABLE.test(u)) return;
    if (u.startsWith(API) || u.startsWith(B)) bag.push(`red: ${r.failure()?.errorText} ${u.slice(0, 90)}`);
  });
}

async function joinExternal(page, link, name = "Tester") {
  await page.goto(`${B}/externa?link=${encodeURIComponent(link)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  // Con el nombre ya recordado, Unify entra sola (flujo de un clic desde la
  // extensión). Si ya estamos adentro, no hay formulario que completar.
  if ((await page.evaluate(() => location.pathname)).includes("/externa/reunion")) {
    await page.waitForTimeout(1600);
    return true;
  }
  const nameField = page.getByLabel("Tu nombre");
  if ((await nameField.count()) === 0) return false;
  await nameField.fill(name);
  const btn = page.getByRole("button", { name: /Unirme acá dentro/i });
  if ((await btn.count()) === 0) return false; // plataforma sin credenciales: correcto
  await btn.click();
  await page.waitForTimeout(2600);
  return true;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });

  // ================= 1. Recorrido completo por plataforma =================
  const platforms = [
    ["Google Meet", `https://meet.google.com/${meetCode()}`],
    ["Jitsi", `https://meet.jit.si/UnifySala${rnd(6)}`],
    ["Teams", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"],
  ];
  for (const [label, link] of platforms) {
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.route("**external_api.js", (r) => r.abort()); // sin red externa en el sandbox

    const joined = await joinExternal(page, link);
    if (!joined) {
      // Sin credenciales en el servidor no se ofrece unirse: es lo correcto.
      check(`${label}: sin credenciales avisa en vez de romperse`,
        (await page.getByText(/no tiene configuradas las credenciales|Abrir en/i).count()) > 0);
      check(`${label}: sin errores en ese camino`, bag.length === 0, bag.slice(0, 2).join(" | "));
      await page.close();
      continue;
    }
    check(`${label}: entra sin romperse (en la reunión y con la capa conectada)`,
      page.url().includes("/externa/reunion") &&
        /Companion activo/.test((await page.locator("body").textContent()) || ""),
      page.url());

    if (joined) {
      // Recorrer TODOS los paneles y controles, que es donde suele romperse.
      for (const nombre of [/Ver la transcripción completa/i, /Asignar roles/i, /Abrir el asistente de IA/i]) {
        const b = page.getByRole("button", { name: nombre });
        if (await b.count()) { await b.first().click(); await page.waitForTimeout(500); }
      }
      // Subtítulos on/off e idioma
      const cap = page.getByRole("button", { name: /subtítulos/i });
      if (await cap.count()) { await cap.first().click(); await page.waitForTimeout(300); await cap.first().click(); }
      const lang = page.getByTitle(/Idioma en el que ves los subtítulos/i);
      if (await lang.count()) { await lang.selectOption("en-US"); await page.waitForTimeout(400); }
      // Abrir/cerrar la invitación
      const inv = page.getByTitle(/Invitar a los demás/i);
      if (await inv.count()) { await inv.click(); await page.waitForTimeout(400); await inv.click(); }
      await page.waitForTimeout(600);
      check(`${label}: sin errores al usar todos los paneles`, bag.length === 0, bag.slice(0, 2).join(" | "));
    }
    await page.close();
  }

  // ================= 2. Conversación real + traducción =================
  {
    const code = meetCode();
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.route("**/api/translate", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "translated line" }) })
    );
    const entro = await joinExternal(page, `https://meet.google.com/${code}`, "Anfitrión");
    check("entra a la reunión externa y conecta la capa de Unify",
      entro && page.url().includes("/externa/reunion") &&
        /Companion activo/.test((await page.locator("body").textContent()) || ""),
      page.url());
    const lang = page.getByTitle(/Idioma en el que ves los subtítulos/i);
    if (await exigir(lang, "el selector «Traducir a» está en el dock")) await lang.selectOption("en-US");

    // Tres personas hablando desde otros dispositivos.
    const socks = [];
    for (const n of ["Ana", "Bruno", "Caro"]) {
      const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
      await new Promise((res) => s.timeout(8000).emit("join-companion",
        { externalKey: `google-meet:${code}`, name: n, language: "es-AR" }, (e, r) => res(r)));
      socks.push(s);
    }
    await sleep(800);
    for (const [i, s] of socks.entries()) {
      s.emit("transcript-line", { alternatives: [`linea numero ${i + 1} de la reunion de prueba`], lang: "es-AR" });
      await sleep(900);
    }
    await sleep(2200);

    const stage = (await page.locator(".min-h-0.flex-1").first().textContent()) || "";
    const body = (await page.locator("body").textContent()) || "";
    check("aparecen las voces de los TRES participantes",
      ["Ana", "Bruno", "Caro"].every((n) => body.includes(n)),
      ["Ana", "Bruno", "Caro"].filter((n) => !body.includes(n)).join(",") || "todos");
    check("se muestra la traducción", body.includes("translated line"));
    check("conversación sin errores", bag.length === 0, bag.slice(0, 2).join(" | "));

    // ---- Reconexión: se cae y vuelve ----
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await sleep(600);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await sleep(1500);
    check("sobrevive a un corte de red simulado", bag.length === 0, bag.slice(0, 2).join(" | "));

    // ---- Salir limpio ----
    const salir = page.getByRole("button", { name: /Salir de la reunión/i });
    if (await exigir(salir, "hay un botón para salir de la reunión")) { await salir.click(); await sleep(1200); }
    // Como invitado, Unify pregunta si querés guardar la reunión en una cuenta
    // antes de salir: es lo correcto, hay que responderle.
    const prompt = page.getByText(/¿Guardar esta reunión\?/i);
    check("como invitado ofrece guardar la reunión antes de salir", (await prompt.count()) > 0);
    const skip = page.getByRole("button", { name: /Guardar \(iniciar sesión\)/i }).first();
    const other = page.locator("button").filter({ hasNotText: /Guardar \(iniciar/i });
    // Elegimos la opción secundaria (seguir sin guardar).
    const secondary = page.getByRole("button", { name: /^(?!Guardar \(iniciar).*$/ }).last();
    if (await prompt.count()) {
      // Por NOMBRE, no por índice (ver sim_malla): un botón transitorio que
      // se va mientras se recorre la lista corría los índices.
      const no = page
        .getByRole("button", { name: /sin guardar|Seguir|No, gracias|Salir igual|Descartar/i })
        .first();
      if (await no.count()) await no.click();
      await sleep(1800);
    }
    const path = await page.evaluate(() => location.pathname);
    check("salir de la reunión no deja la página rota", !path.includes("/externa/reunion"), `path=${path}`);
    check("sin errores al salir", bag.length === 0, bag.slice(0, 2).join(" | "));

    socks.forEach((s) => s.disconnect());
    await page.close();
  }

  // ================= 3. Refrescar la URL de la reunión =================
  {
    const page = await ctx.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await page.goto(`${B}/externa/reunion`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const path = await page.evaluate(() => location.pathname);
    check("entrar directo a la URL de reunión redirige limpio", path === "/externa", `path=${path}`);
    check("sin errores al redirigir", bag.length === 0, bag.slice(0, 2).join(" | "));
    await page.close();
  }

  // ================= 4. Móvil / tablet (como el iPad del usuario) =================
  {
    const mob = await browser.newContext({
      viewport: { width: 820, height: 1180 }, // iPad en vertical
      permissions: ["microphone"],
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
    const page = await mob.newPage();
    const bag = [];
    watch(page, bag);
    await page.route("**fonts.g**", (r) => r.abort());
    await joinExternal(page, `https://meet.google.com/${meetCode()}`, "iPad");
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("en tablet no hay desborde horizontal", ov <= 2, `desborde=${ov}px`);
    check("en tablet se ve la pantalla de subtítulos", (await page.getByText(/subtítulos aparecen acá|Escuchando|Micrófono/i).count()) > 0);
    check("en tablet el dock es accesible", (await page.getByTitle(/Invitar a los demás/i).count()) > 0);
    check("sin errores en tablet", bag.length === 0, bag.slice(0, 2).join(" | "));
    await mob.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
