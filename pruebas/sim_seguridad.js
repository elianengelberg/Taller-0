// Ataques reales contra el servidor: falsificar sesión, leer datos ajenos,
// gastar nuestra plata en la IA, usar el servidor de alojamiento gratis,
// inyectar HTML y suplantar identidad dentro de una reunión.
//
// No alcanza con que los endpoints "existan": lo que se prueba acá es que
// hacer trampa NO funciona.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const crypto = require("crypto");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

(async () => {
  // Dos cuentas: una víctima y un atacante.
  const mk = async (tag) => {
    const email = `${tag}${Date.now()}${rnd(4)}@test.com`;
    const r = await api("/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "unaClaveLarga123", name: tag }),
    });
    return { email, token: r.body.token, id: r.body.user?.id };
  };
  const victima = await mk("victima");
  const atacante = await mk("atacante");
  const authV = { Authorization: `Bearer ${victima.token}` };
  const authA = { Authorization: `Bearer ${atacante.token}` };

  // ═══════ 1. Falsificar la sesión ═══════
  console.log("\n── 1. Falsificar sesión ──");
  {
    // El ataque clásico: firmar un token con la clave que está en el código.
    const forge = (secret, sub, alg = "HS256") => {
      const h = b64url(JSON.stringify({ alg, typ: "JWT" }));
      const now = Math.floor(Date.now() / 1000);
      const p = b64url(JSON.stringify({ sub, iat: now, exp: now + 3600 }));
      const sig = b64url(crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest());
      return `${h}.${p}.${sig}`;
    };
    const conClaveDelCodigo = forge("encuentro-dev-secret-change-me", victima.id);
    const r1 = await api("/api/auth/me", { headers: { Authorization: `Bearer ${conClaveDelCodigo}` } });
    check("no se puede entrar firmando con la clave que está en el código", r1.status === 401, `HTTP ${r1.status}`);

    // alg: none, el otro clásico.
    const h = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const p = b64url(JSON.stringify({ sub: victima.id, iat: 1, exp: 9999999999 }));
    const r2 = await api("/api/auth/me", { headers: { Authorization: `Bearer ${h}.${p}.` } });
    check("no se puede entrar con alg:none", r2.status === 401, `HTTP ${r2.status}`);

    // Token de otro con el payload cambiado a mano.
    const [th, , ts] = atacante.token.split(".");
    const tampered = `${th}.${b64url(JSON.stringify({ sub: victima.id, iat: 1, exp: 9999999999 }))}.${ts}`;
    const r3 = await api("/api/auth/me", { headers: { Authorization: `Bearer ${tampered}` } });
    check("no se puede cambiar el usuario del propio token", r3.status === 401, `HTTP ${r3.status}`);

    // Token vencido.
    const expired = (() => {
      const hh = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const pp = b64url(JSON.stringify({ sub: victima.id, iat: 1, exp: 2 }));
      return `${hh}.${pp}.${b64url(crypto.randomBytes(32))}`;
    })();
    const r4 = await api("/api/auth/me", { headers: { Authorization: `Bearer ${expired}` } });
    check("un token vencido no sirve", r4.status === 401, `HTTP ${r4.status}`);

    const r5 = await api("/api/auth/me", { headers: { Authorization: `Bearer ${"x".repeat(9000)}` } });
    check("un token gigante se rechaza sin trabajar", r5.status === 401, `HTTP ${r5.status}`);
  }

  // ═══════ 2. Leer datos de otra persona ═══════
  console.log("\n── 2. Datos ajenos ──");
  {
    // La víctima crea una reunión desde el socket (con su sesión).
    const s = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { s.on("connect", r); s.on("connect_error", x); });
    const ack = await new Promise((res) => s.timeout(8000).emit("create-meeting",
      { hostName: "Victima", hostLanguage: "es-AR", roles: [], token: victima.token }, (e, r) => res(r)));
    const dbId = ack?.meeting?.dbId;
    s.emit("transcript-line", { alternatives: ["esto es informacion confidencial de la victima"], lang: "es-AR" });
    await sleep(2200);

    const mine = await api(`/api/meetings/${dbId}`, { headers: authV });
    check("la dueña puede leer su reunión", mine.status === 200, `HTTP ${mine.status}`);
    const theirs = await api(`/api/meetings/${dbId}`, { headers: authA });
    check("otra persona NO puede leer esa reunión", theirs.status === 404 || theirs.status === 403, `HTTP ${theirs.status}`);
    const anon = await api(`/api/meetings/${dbId}`);
    check("sin sesión tampoco", anon.status === 401, `HTTP ${anon.status}`);

    // Preguntarle a la IA sobre una reunión ajena.
    const askTheirs = await api(`/api/meetings/${dbId}/ask`, {
      method: "POST", headers: { "Content-Type": "application/json", ...authA },
      body: JSON.stringify({ question: "¿Qué se dijo?" }),
    });
    check("no se le puede preguntar a la IA sobre una reunión ajena",
      askTheirs.status >= 400, `HTTP ${askTheirs.status}`);

    // Reclamar una reunión que ya tiene dueño.
    const claim = await api(`/api/meetings/${dbId}/claim`, { method: "POST", headers: authA });
    check("no se puede robar una reunión con dueño", claim.body?.ok === false, JSON.stringify(claim.body));

    // Plantar una grabación arbitraria en la reunión de otro.
    const plant = await api(`/api/meetings/${dbId}/recording-complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicUrl: "https://evil.co/malware.mp4" }),
    });
    check("no se puede plantar una grabación de otro dominio", plant.status === 400, `HTTP ${plant.status}`);
    s.disconnect();
  }

  // ═══════ 3a. Validación de entrada (antes de gastar el cupo del limitador,
  //             o todo respondería 429 y no se probaría nada) ═══════
  console.log("\n── 3. Validación de entrada ──");
  {
    const big = await api("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "a".repeat(50000), source: "es-AR", target: "en-US" }),
    });
    check("un texto gigante para traducir se rechaza por tamaño", big.status === 400, `HTTP ${big.status}`);

    const bad = await api(`/api/meetings/${crypto.randomUUID()}/recording-upload-url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "text/html" }),
    });
    check("un tipo de archivo arbitrario no se acepta tal cual",
      bad.status !== 200 || !JSON.stringify(bad.body).includes("text/html"), `HTTP ${bad.status}`);

    const teams = await api("/api/teams/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    check("un fallo de Teams no filtra el detalle de Azure",
      teams.status !== 502 || !/connection|endpoint|azure|resource/i.test(JSON.stringify(teams.body)),
      `HTTP ${teams.status} ${JSON.stringify(teams.body).slice(0, 70)}`);
  }

  // ═══════ 6. Fugas de información ═══════
  console.log("\n── 6. Fugas ──");
  {
    const cfg = await api("/api/auth/config");
    const platforms = await api("/api/platforms");
    const blob = JSON.stringify(cfg.body) + JSON.stringify(platforms.body);
    // Estos dos endpoints son banderas: "¿está configurado esto?". Todos sus
    // valores tienen que ser booleanos.
    //
    // Antes se buscaban palabras sospechosas ("secret", "password"...) en el
    // JSON, pero eso miraba los NOMBRES: una bandera honesta llamada
    // `passwordReset: false` la hacía fallar, y un secreto guardado bajo un
    // nombre inocente pasaba sin problema. Exigir que todo sea booleano es más
    // estricto: cualquier valor de texto -- una clave, una URL interna, una
    // cadena de conexión -- rompe el test por definición.
    const noBooleanos = [...Object.entries(cfg.body), ...Object.entries(platforms.body)]
      .filter(([, v]) => typeof v !== "boolean");
    check("la config pública sólo publica banderas, ningún valor",
      noBooleanos.length === 0, noBooleanos.length ? JSON.stringify(noBooleanos) : blob.slice(0, 80));

    const missing = await api(`/api/meetings/${crypto.randomUUID()}`, { headers: authV });
    check("una reunión inexistente no filtra rastro de pila",
      !/at \/|node_modules|Error:/i.test(JSON.stringify(missing.body)), JSON.stringify(missing.body).slice(0, 70));
  }

  // ═══════ 3b. Gastar nuestra plata ═══════
  console.log("\n── 3. Abuso de los endpoints que cuestan ──");
  {
    // /api/translate llama a Claude y no pide sesión: sin límite, es una API
    // de traducción gratis pagada por nosotros.
    let blocked = 0, ok = 0;
    for (let i = 0; i < 300; i++) {
      const r = await api("/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `linea ${i}`, source: "es-AR", target: "en-US" }),
      });
      if (r.status === 429) { blocked++; break; }
      ok++;
    }
    check("traducir en masa termina cortado (429)", blocked > 0, `permitidos=${ok}`);

    const r429 = await api("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hola", source: "es-AR", target: "en-US" }),
    });
    check("el 429 trae Retry-After o mensaje claro", r429.status === 429 && Boolean(r429.body.error),
      JSON.stringify(r429.body).slice(0, 60));

    // Credenciales de terceros (Zoom/Azure) a nuestro nombre.
    let credBlocked = false;
    for (let i = 0; i < 60; i++) {
      const r = await api("/api/zoom/signature", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingNumber: "89123456789", role: 0 }),
      });
      if (r.status === 429) { credBlocked = true; break; }
    }
    check("pedir firmas de Zoom en masa se corta", credBlocked);

  }

  // ═══════ 4. Usar el servidor como alojamiento ═══════
  console.log("\n── 4. Subidas ──");
  {
    let upBlocked = false;
    for (let i = 0; i < 40; i++) {
      const r = await api(`/api/meetings/${crypto.randomUUID()}/recording-upload-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: "video/mp4" }),
      });
      if (r.status === 429) { upBlocked = true; break; }
    }
    check("no se puede pedir subidas sin fin", upBlocked);

  }

  // ═══════ 5. Suplantar identidad dentro de una reunión ═══════
  console.log("\n── 5. Dentro de la reunión ──");
  {
    const code = `${rnd(3)}-${rnd(4)}-${rnd(3)}`;
    const key = `google-meet:${code}`;
    const host = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { host.on("connect", r); host.on("connect_error", x); });
    await new Promise((res) => host.timeout(8000).emit("join-companion",
      { externalKey: key, name: "Anfitriona", language: "es-AR", token: victima.token }, (e, r) => res(r)));

    const intruso = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { intruso.on("connect", r); intruso.on("connect_error", x); });
    const iack = await new Promise((res) => intruso.timeout(8000).emit("join-companion",
      { externalKey: key, name: "Intruso", language: "es-AR" }, (e, r) => res(r)));

    // Moderar sin ser anfitrión.
    const mod = await new Promise((res) => intruso.timeout(6000).emit("moderate",
      { action: "kick", targetId: iack?.meeting?.participants?.[0]?.id }, (e, r) => res(r ?? { ok: false })));
    check("un participante cualquiera no puede echar a otro", mod?.ok !== true, JSON.stringify(mod));

    // Inundar la sala con transcripción.
    let flooded = 0;
    for (let i = 0; i < 200; i++) { intruso.emit("transcript-line", { alternatives: [`spam ${i}`], lang: "es-AR" }); flooded++; }
    await sleep(2500);
    const sess = await api(`/api/meet-bridge/${code}/session`);
    const lines = sess.body?.transcript?.length ?? 0;
    check("la inundación de transcripción está limitada", lines < flooded, `enviadas=${flooded} guardadas=${lines}`);

    // El nombre no puede llevar HTML ni ser infinito.
    const raro = io(API, { transports: ["websocket"], forceNew: true, reconnection: false });
    await new Promise((r, x) => { raro.on("connect", r); raro.on("connect_error", x); });
    const rack = await new Promise((res) => raro.timeout(8000).emit("join-companion",
      { externalKey: key, name: "<img src=x onerror=alert(1)>".repeat(50), language: "es-AR" }, (e, r) => res(r)));
    const me = rack?.meeting?.participants?.find((p) => p.id === rack.selfId);
    check("el nombre se recorta a un largo sano", (me?.name?.length ?? 999) <= 60, `largo=${me?.name?.length}`);

    host.disconnect(); intruso.disconnect(); raro.disconnect();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
