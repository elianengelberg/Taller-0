// Verifica las 3 correcciones urgentes contra el stack real.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const BASE = "http://localhost:4174";
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(name) {
  const r = await fetch(`${API}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${name}${Date.now()}${Math.floor(Math.random() * 1e6)}@t.com`, name, password: "password123" }) });
  const j = await r.json();
  return { token: j.token, email: j.user?.email };
}
// A logged-in owner opens the companion room first (so it gets an owner).
function ownerJoinsCompanion(externalKey, token) {
  return new Promise((res, rej) => {
    const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    s.on("connect", () => s.timeout(8000).emit("join-companion",
      { externalKey, name: "Dueño", language: "es-AR", token }, (e, r) => e || !r?.ok ? rej(e || new Error("join failed")) : res({ s, dbId: r.meeting.dbId })));
    s.on("connect_error", rej);
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });

  // ============ FIX 3: el reclamo de invitado no puede mentir ============
  // Caso A: la sala externa YA tiene dueño → el reclamo del invitado debe fallar
  // y avisarlo, SIN borrar el puntero local.
  {
    const owner = await register("Duena");
    const key = "zoom:" + Date.now();
    const { s: ownerSock, dbId } = await ownerJoinsCompanion(key, owner.token);

    const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    // Simulamos al invitado que salió y salteó el guardado: queda el puntero local.
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await p.evaluate(([id, code]) => localStorage.setItem("encuentro_unsaved_meeting",
      JSON.stringify({ dbId: id, joinCode: code, endedAt: Date.now() })), [dbId, key]);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(600);
    check("el invitado ve el aviso de 'reunión reciente sin guardar'",
      (await p.getByText(/reunión reciente sin guardar/i).count()) > 0);

    // Se registra desde ese aviso.
    await p.getByRole("link", { name: /creá una cuenta/i }).click();
    await p.waitForTimeout(700);
    const em = `inv${Date.now()}@t.com`;
    await p.locator("#name").fill("Invitado Tardío");
    await p.locator("#email").fill(em);
    await p.locator("#password").fill("password123");
    await p.getByRole("button", { name: /^Crear cuenta$/ }).click();
    await p.waitForTimeout(2500);

    const onHistory = await p.evaluate(() => location.pathname.includes("/historial"));
    check("tras registrarse aterriza en el historial", onHistory, await p.evaluate(() => location.pathname));
    check("SE LE AVISA que la reunión ya es de otra cuenta (no miente)",
      (await p.getByText(/ya está guardada en la cuenta de quien la abrió/i).count()) > 0);
    const stillThere = await p.evaluate(() => localStorage.getItem("encuentro_unsaved_meeting"));
    check("NO se borra el puntero local cuando el reclamo falla", stillThere !== null);
    ownerSock.disconnect();
    await ctx.close();
  }

  // Caso B: la reunión no tiene dueño → el reclamo SÍ funciona y no muestra aviso.
  {
    const key = "jitsi:libre-" + Date.now();
    // Sala abierta por un INVITADO (sin token) → queda sin dueño.
    const { s: guestSock, dbId } = await new Promise((res, rej) => {
      const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
      s.on("connect", () => s.timeout(8000).emit("join-companion",
        { externalKey: key, name: "Invitado", language: "es-AR" }, (e, r) => e || !r?.ok ? rej(e || new Error("fail")) : res({ s, dbId: r.meeting.dbId })));
      s.on("connect_error", rej);
    });
    guestSock.disconnect();
    await sleep(300);

    const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await p.evaluate(([id, code]) => localStorage.setItem("encuentro_unsaved_meeting",
      JSON.stringify({ dbId: id, joinCode: code, endedAt: Date.now() })), [dbId, key]);
    await p.goto(`${BASE}/registrarse`, { waitUntil: "domcontentloaded" });
    // Navegamos con el state del reclamo como lo hace el aviso del inicio.
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
    await p.getByRole("link", { name: /creá una cuenta/i }).click();
    await p.waitForTimeout(700);
    await p.locator("#name").fill("Dueño Nuevo");
    await p.locator("#email").fill(`nue${Date.now()}@t.com`);
    await p.locator("#password").fill("password123");
    await p.getByRole("button", { name: /^Crear cuenta$/ }).click();
    await p.waitForTimeout(2500);

    check("reclamo VÁLIDO: no muestra el aviso de fallo",
      (await p.getByText(/ya está guardada en la cuenta de quien la abrió/i).count()) === 0);
    const cleared = await p.evaluate(() => localStorage.getItem("encuentro_unsaved_meeting"));
    check("reclamo VÁLIDO: se limpia el puntero local", cleared === null);
    const cards = await p.getByText(/Reunión de/i).count();
    check("reclamo VÁLIDO: la reunión aparece en el historial", cards > 0, `tarjetas=${cards}`);
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SIM ERROR:", e.message, e.stack); process.exit(1); });
