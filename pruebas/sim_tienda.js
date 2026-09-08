// LO QUE PIDIÓ LA CERTIFICACIÓN DE LA MICROSOFT STORE (informe del 7/9):
//  - 11.16 Contenido generado por IA: tiene que haber un «Reportar» para todo
//    lo que escribe un modelo (respuestas del asistente, informes).
//  - 10.1.5 Distribución de software: adentro de la app de la tienda no se
//    puede promocionar instalar software de afuera (el .exe, otras
//    plataformas, la extensión). La app de escritorio carga la web, así que
//    la web tiene que saber que corre adentro (Electron en el user agent).
//
// Corre contra la web (4174) y el servidor (4001) reales.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const fs = require("fs");
const B = "http://localhost:4174", API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA_ESCRITORIO = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Unify/1.7.3 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// Palabras que en la app de la tienda no pueden aparecer como oferta de
// instalar algo de afuera.
const PROMO = /Descargar|Elegí tu sistema|Chrome Web Store|Microsoft Store|\.exe\b|Android|iPhone\/iPad|App Store|Play Store/i;

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();
  const errs = [];
  const watch = (p) => p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

  console.log("── 1. Adentro de la app de escritorio no se promociona instalar nada ──");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA_ESCRITORIO });
    const p = await ctx.newPage();
    watch(p);
    await p.goto(`${B}/`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1200);
    const enlacesInstalar = await p.locator('a[href="/instalar"]').count();
    check("la portada, adentro de la app, no tiene ningún enlace a «Instalar»", enlacesInstalar === 0, `enlaces=${enlacesInstalar}`);
    check("ni el botón «Instalar Unify»", (await p.getByRole("button", { name: /Instalar Unify/i }).count()) === 0);
    check("la versión del pie se ve, pero ya no lleva a /instalar", (await p.getByText(/Versión 20/).count()) >= 1 && enlacesInstalar === 0);

    await p.goto(`${B}/instalar`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    const cuerpo = (await p.locator("main, body").first().textContent()) || "";
    check("/instalar dice que Unify ya está instalado en esta computadora", /ya está instalado en esta computadora/i.test(cuerpo), cuerpo.slice(0, 80).replace(/\s+/g, " "));
    check("y no ofrece descargas, otras plataformas ni tiendas ajenas", !PROMO.test(cuerpo), (cuerpo.match(PROMO) || [""])[0]);
    check("sí ofrece seguir usando la app (unirse a una reunión, historial)", (await p.getByRole("link", { name: /historial/i }).count()) >= 1 && /Unirme a una reunión/.test(cuerpo));

    await p.goto(`${B}/soporte`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(800);
    check("la ayuda tampoco enlaza a /instalar adentro de la app", (await p.locator('a[href="/instalar"]').count()) === 0);
    check("sin errores de JavaScript adentro de la app", errs.length === 0, errs[0] || "");
    await ctx.close();
  }

  console.log("── 2. En un navegador común, instalar sigue ofreciéndose ──");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA_NAVEGADOR });
    const p = await ctx.newPage();
    await p.goto(`${B}/`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    check("en el navegador la portada SÍ tiene «Instalar»", (await p.locator('a[href="/instalar"]').count()) >= 1);
    await p.goto(`${B}/instalar`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1000);
    check("y /instalar muestra el selector de sistema como siempre", /Elegí tu sistema/i.test((await p.locator("body").textContent()) || ""));
    await ctx.close();
  }

  console.log("── 3. Reportar contenido generado por IA (endpoint) ──");
  const email = `reporta${Date.now()}@test.com`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "melon42Trueno", name: "Reportera" }),
  }).then((r) => r.json());
  const { rows: [usuaria] } = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
  {
    const anon = await fetch(`${API}/api/reportes-ia`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: "respuesta", contenido: "La IA dijo que aprobamos el presupuesto.", motivo: "Nadie dijo eso." }),
    });
    const anonJson = await anon.json().catch(() => ({}));
    check("cualquiera puede reportar una respuesta de la IA (200, con id)", anon.status === 200 && anonJson.ok === true && typeof anonJson.id === "string", `HTTP ${anon.status} ${JSON.stringify(anonJson)}`);
    const { rows } = await pg.query(`SELECT user_id, kind, content, reason FROM ai_reports WHERE id = $1`, [anonJson.id]);
    check("el reporte queda guardado en la base (tipo, contenido y motivo)", rows[0]?.kind === "respuesta" && /aprobamos/.test(rows[0]?.content || "") && /Nadie dijo eso/.test(rows[0]?.reason || "") && rows[0]?.user_id === null, JSON.stringify(rows[0]));
    await sleep(600);
    const log = fs.readFileSync("/tmp/unify-server.log", "utf8");
    check("y sale un correo a soporte con el reporte", /Asunto: \[Unify\] Reporte de contenido de IA \(respuesta\)/.test(log) && /Nadie dijo eso/.test(log));

    const conSesion = await fetch(`${API}/api/reportes-ia`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ tipo: "informe", contenido: "Informe con datos inventados", motivo: "inventa una decisión", meetingId: "abc" }),
    }).then((r) => r.json());
    const { rows: mios } = await pg.query(`SELECT user_id, meeting_id FROM ai_reports WHERE id = $1`, [conSesion.id]);
    check("con sesión, el reporte queda ligado a la cuenta y a la reunión", mios[0]?.user_id === usuaria?.id && mios[0]?.meeting_id === "abc", JSON.stringify(mios[0]));
    const vacio = await fetch(`${API}/api/reportes-ia`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tipo: "respuesta", contenido: "" }) });
    check("sin contenido, 400", vacio.status === 400, `HTTP ${vacio.status}`);
  }

  console.log("── 4. El «Reportar» en la pantalla: informe y respuestas del asistente ──");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA_ESCRITORIO });
    const p = await ctx.newPage();
    const errs2 = [];
    p.on("pageerror", (e) => errs2.push(e.message.slice(0, 120)));
    // Una reunión de la usuaria con un informe ya escrito por la IA.
    const id = require("crypto").randomUUID();
    await pg.query(
      `INSERT INTO meetings (id, join_code, host_name, owner_id, report, ended_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [id, "REPORT1", "Reportera", usuaria.id, "## Resumen\n\nSe aprobó el presupuesto del trimestre sin objeciones."]
    );
    await p.goto(`${B}/`, { waitUntil: "domcontentloaded" });
    await p.evaluate((t) => localStorage.setItem("encuentro_token", t), reg.token);
    // El asistente contesta: se simula la IA para no depender de una clave.
    await p.route("**/api/meetings/*/ask", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "Se decidió **posponer** la reunión." }) }));
    await p.goto(`${B}/historial/${id}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const reportar = p.getByRole("button", { name: /Reportar este informe/i });
    check("debajo del informe de la IA hay un botón «Reportar este informe»", (await reportar.count()) === 1);
    await reportar.first().click();
    await p.getByLabel("Motivo").fill("El informe dice que se aprobó y no fue así.");
    await p.getByRole("button", { name: /Enviar reporte/i }).click();
    await p.waitForTimeout(1500);
    check("al enviarlo, agradece y confirma que se revisa", (await p.getByText(/recibimos tu reporte/i).count()) === 1);
    const { rows: delInforme } = await pg.query(`SELECT kind, meeting_id, user_id FROM ai_reports WHERE meeting_id = $1`, [id]);
    check("y llega al servidor como reporte de informe de ESA reunión, a nombre de la usuaria", delInforme.some((r) => r.kind === "informe" && r.user_id === usuaria.id), JSON.stringify(delInforme));

    // Una pregunta al asistente: la respuesta también trae su «Reportar».
    const caja = p.getByPlaceholder(/Qué dijo|Preguntá|pregunta/i).first();
    if (await caja.count()) {
      await caja.fill("¿Qué se decidió?");
      await caja.press("Enter");
      await p.waitForTimeout(1500);
      check("cada respuesta del asistente trae «Reportar esta respuesta»", (await p.getByRole("button", { name: /Reportar esta respuesta/i }).count()) >= 1);
    } else {
      check("la pantalla de la reunión tiene la caja del asistente", false, "no está");
    }
    check("sin errores de JavaScript en el historial", errs2.length === 0, errs2[0] || "");

    // La página de ayuda: el formulario libre.
    await p.goto(`${B}/soporte`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(800);
    check("la ayuda explica cómo reportar contenido de la IA", (await p.getByRole("heading", { name: /Reportar contenido generado por IA/i }).count()) === 1);
    await p.getByLabel(/El contenido que querés reportar/i).fill("Respuesta con un dato falso");
    await p.getByLabel("Motivo").fill("Es falso");
    await p.getByRole("button", { name: /Enviar reporte/i }).click();
    await p.waitForTimeout(1500);
    check("y su formulario manda el reporte", (await p.getByText(/recibimos tu reporte/i).count()) === 1);
    await ctx.close();
  }

  await pg.end();
  await browser.close();
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
