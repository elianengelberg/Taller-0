// Foto de perfil y edición del perfil, de punta a punta: que se guarde, se
// pueda cambiar y sacar, que aparezca junto al nombre en los subtítulos (como
// Zoom), y que nadie pueda ponerse la cara de otro ni usar una URL cualquiera.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const meetCode = () => `${rnd(3)}-${rnd(4)}-${rnd(3)}`;

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  console.log("\n── 1. Perfil: nombre y foto ──");
  const email = `perfil${Date.now()}@test.com`;
  const reg = await api("/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "unaClave123", name: "Juan Pablo Nora" }),
  });
  check("se crea la cuenta", reg.status === 200 && Boolean(reg.body.token), `HTTP ${reg.status}`);
  check("una cuenta nueva arranca sin foto", reg.body.user?.avatarUrl === null, String(reg.body.user?.avatarUrl));
  const token = reg.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const rename = await api("/api/auth/me", {
    method: "PATCH", headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ name: "Juan P. Nora" }),
  });
  check("se puede editar el nombre", rename.body.user?.name === "Juan P. Nora", rename.body.user?.name);

  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();
  const fakePhoto = "https://lh3.googleusercontent.com/a/fotoDePrueba=s96-c";
  await pg.query("UPDATE users SET avatar_url = $2 WHERE email = $1", [email, fakePhoto]);

  const me = await api("/api/auth/me", { headers: auth });
  check("la foto llega en /api/auth/me", me.body.user?.avatarUrl === fakePhoto, me.body.user?.avatarUrl);

  const rename2 = await api("/api/auth/me", {
    method: "PATCH", headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ name: "Juan Pablo Nora" }),
  });
  check("guardar el nombre NO borra la foto", rename2.body.user?.avatarUrl === fakePhoto, rename2.body.user?.avatarUrl);

  const clear = await api("/api/auth/me", {
    method: "PATCH", headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ name: "Juan Pablo Nora", avatarUrl: null }),
  });
  check("se puede sacar la foto", clear.body.user?.avatarUrl === null, String(clear.body.user?.avatarUrl));

  console.log("\n── 2. Seguridad de la foto ──");
  for (const [label, url] of [
    ["una URL cualquiera", "https://evil.co/pixel.png"],
    ["un javascript:", "javascript:alert(1)"],
    ["typosquat de Google", "https://googleusercontent.com.evil.co/a/x"],
    ["un data: URL", "data:image/svg+xml,<svg onload=alert(1)>"],
  ]) {
    const bad = await api("/api/auth/me", {
      method: "PATCH", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ name: "Juan Pablo Nora", avatarUrl: url }),
    });
    check(`se rechaza ${label}`, bad.status === 400, `HTTP ${bad.status}`);
  }
  const after = await api("/api/auth/me", { headers: auth });
  check("ninguna URL rechazada quedó guardada", after.body.user?.avatarUrl === null, String(after.body.user?.avatarUrl));

  const noAuth = await fetch(`${API}/api/auth/me/avatar`, {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: new Uint8Array([1, 2, 3]),
  });
  check("no se puede subir una foto sin sesión", noAuth.status === 401, `HTTP ${noAuth.status}`);
  const badType = await fetch(`${API}/api/auth/me/avatar`, {
    method: "POST", headers: { "Content-Type": "application/pdf", ...auth }, body: new Uint8Array([1, 2, 3]),
  });
  check("no se acepta un archivo que no sea imagen", [400, 503].includes(badType.status), `HTTP ${badType.status}`);

  console.log("\n── 3. La foto llega a la reunión ──");
  await pg.query("UPDATE users SET avatar_url = $2 WHERE email = $1", [email, fakePhoto]);
  const code = meetCode();
  const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
  const ack = await new Promise((res) => s.timeout(8000).emit("join-companion",
    { externalKey: `google-meet:${code}`, name: "Juan Pablo Nora", language: "es-AR", token }, (e, r) => res(r)));
  const meSelf = ack?.meeting?.participants?.find((p) => p.id === ack.selfId);
  check("el participante logueado llega con su foto", meSelf?.avatarUrl === fakePhoto, String(meSelf?.avatarUrl));

  const g = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { g.on("connect", r); g.on("connect_error", x); });
  const gack = await new Promise((res) => g.timeout(8000).emit("join-companion",
    { externalKey: `google-meet:${code}`, name: "Invitada", language: "es-AR" }, (e, r) => res(r)));
  check("un invitado sin cuenta no tiene foto (y no rompe)",
    gack?.meeting?.participants?.find((p) => p.id === gack.selfId)?.avatarUrl === null);

  const imp = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r, x) => { imp.on("connect", r); imp.on("connect_error", x); });
  const iack = await new Promise((res) => imp.timeout(8000).emit("join-companion",
    { externalKey: `google-meet:${code}`, name: "Impostor", language: "es-AR",
      avatarUrl: "https://lh3.googleusercontent.com/a/otraPersona" }, (e, r) => res(r)));
  check("no se puede entrar con la cara de otro",
    iack?.meeting?.participants?.find((p) => p.id === iack.selfId)?.avatarUrl === null);

  console.log("\n── 4. La foto en los subtítulos ──");
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  await ctx.route("**fonts.g**", (r) => r.abort());
  const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64");
  await ctx.route("**googleusercontent.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.goto(`${B}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("encuentro_token", t), token);
  await page.evaluate(() => localStorage.setItem("unify_autorecord_externa", "0"));

  await page.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill(`https://meet.google.com/${code}`);
  await page.getByLabel("Tu nombre").fill("Juan Pablo Nora");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Unirme/i }).first().click();
  await page.waitForTimeout(3000);

  s.emit("transcript-line", { alternatives: ["y como se llega a eso al poder judicial"], lang: "es-AR" });
  await sleep(2500);
  const stage = page.locator(".min-h-0.flex-1").first();
  check("la foto aparece junto al nombre en los subtítulos", (await stage.locator("img").count()) > 0);
  check("el nombre completo acompaña a la foto",
    ((await page.locator("body").textContent()) || "").includes("Juan Pablo Nora"));

  g.emit("transcript-line", { alternatives: ["yo tampoco tengo foto de perfil cargada"], lang: "es-AR" });
  await sleep(2500);
  const initials = await stage.locator("span.rounded-full span").allTextContents();
  check("sin foto se muestran las iniciales de la persona", initials.includes("I"), JSON.stringify(initials));
  check("la persona con foto muestra foto y la otra iniciales, en la misma lista",
    (await stage.locator("img").count()) === 1 && initials.length >= 1,
    `imgs=${await stage.locator("img").count()} iniciales=${JSON.stringify(initials)}`);
  check("sin errores de JavaScript", errs.length === 0, errs[0] || "");

  console.log("\n── 5. Editor de perfil ──");
  const p2 = await ctx.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message.slice(0, 140)));
  await p2.goto(`${B}/`, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(1500);
  const menuBtn = p2.getByRole("button", { name: /Hola,|Juan/i }).first();
  if (await menuBtn.count()) { await menuBtn.click(); await p2.waitForTimeout(400); }
  const cfg = p2.getByRole("button", { name: /Configuración|cuenta/i }).first();
  if (await cfg.count()) { await cfg.click(); await p2.waitForTimeout(700); }
  const modalText = (await p2.locator("body").textContent()) || "";
  check("el perfil ofrece editar el nombre", modalText.includes("Nombre"));
  check("el perfil tiene sección de foto", /Foto de perfil/i.test(modalText));
  const canUpload = await p2.getByText(/Subir foto|Cambiar foto/i).count();
  const honest = /no tiene configurado dónde guardar fotos/i.test(modalText);
  check("sin almacenamiento lo dice en vez de ofrecer un botón roto",
    (canUpload === 0 && honest) || (canUpload > 0 && !honest), `botón=${canUpload} aviso=${honest}`);
  check("el editor de perfil no tira errores", errs2.length === 0, errs2[0] || "");

  console.log("\n── Seguimiento de palabras: la lista por usuario ──");
  {
    const reg = await fetch(`${API}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `palabras${Date.now()}@test.com`, password: "melon42Trueno", name: "Rastreadora" }),
    }).then((r) => r.json());
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` };

    const sinSesion = await fetch(`${API}/api/palabras-seguidas`);
    check("sin sesión, la lista es privada (401)", sinSesion.status === 401, `HTTP ${sinSesion.status}`);

    const guardado = await fetch(`${API}/api/palabras-seguidas`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ palabras: ["presupuesto", "  deadline  ", "presupuesto", "", 42] }),
    }).then((r) => r.json());
    check("guarda limpiando: recorta, saca duplicados y basura",
      JSON.stringify(guardado.palabras) === JSON.stringify(["presupuesto", "deadline"]),
      JSON.stringify(guardado.palabras));

    const leido = await fetch(`${API}/api/palabras-seguidas`, { headers: auth }).then((r) => r.json());
    check("y al releer la lista vuelve igual",
      JSON.stringify(leido.palabras) === JSON.stringify(["presupuesto", "deadline"]),
      JSON.stringify(leido.palabras));
  }

  await browser.close();
  s.disconnect(); g.disconnect(); imp.disconnect();
  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
