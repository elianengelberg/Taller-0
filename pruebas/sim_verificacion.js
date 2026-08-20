// Las pantallas nuevas, en un navegador de verdad: confirmar el email y
// recuperar la contraseña, haciendo clic donde haría clic una persona.
//
// El servidor corre con MAIL_LOG=1, así que los enlaces se leen de su consola
// -- que es exactamente lo que haría alguien probando esto en su máquina.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const fs = require("fs");
const B = "http://localhost:4174";
const API = "http://localhost:4001";
const LOG = "/tmp/unify-server.log";
const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Se leen todos los correos del log y se toma el último de esa dirección con
// el tipo de enlace pedido: una misma casilla puede recibir dos casi juntos.
async function linkFor(to, path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.readFileSync(LOG, "utf8");
    const re = /\[mail\] Para: (.+)\n\[mail\] Asunto: .+\n([\s\S]*?)\[mail\] ─/g;
    let m;
    let found = null;
    while ((m = re.exec(text))) {
      if (m[1].trim() !== to) continue;
      const link = (m[2].match(/https?:\/\/\S+/g) ?? []).find((l) => l.includes(path));
      if (link) found = link;
    }
    if (found) return found;
    await sleep(150);
  }
  return null;
}

const api = async (path, body) => {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const errores = [];
  const nuevaPagina = async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errores.push(e.message));
    return { ctx, page };
  };
  const texto = (page) => page.evaluate(() => document.body.innerText);
  const PASS = "melon42Trueno";

  // ═══════ 1. Registrarse y ver el aviso ═══════
  console.log("\n── 1. Registrarse desde la web ──");
  const email = `web${Date.now()}${rnd(4)}@test.com`;
  let { ctx, page } = await nuevaPagina();
  await page.goto(`${B}/registrarse`, { waitUntil: "networkidle" });
  await page.fill("#name", "Marta Ríos");
  await page.fill("#email", email);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);

  await page.goto(`${B}/historial`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  let t = await texto(page);
  check("en el historial avisa que falta confirmar el email", /falta confirmar tu email/i.test(t));
  check("y dice para qué sirve confirmarlo, no sólo que lo hagas", /recuperar la cuenta/i.test(t));
  check("muestra a qué dirección lo mandó", t.includes(email));

  const linkVerif = await linkFor(email, "/verificar-email");
  check("el correo con el enlace llegó", Boolean(linkVerif), linkVerif?.slice(0, 50) ?? "no llegó");

  // ═══════ 2. Sin confirmar, no se entra ═══════
  console.log("\n── 2. Intentar entrar sin confirmar ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("la pantalla de ingreso ofrece “¿Olvidaste tu contraseña?”", /olvidaste tu contraseña/i.test(await texto(page)));

  await page.fill("#email", email);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  t = await texto(page);
  check("no deja entrar y explica que falta confirmar", /no confirmaste tu email/i.test(t), t.slice(0, 90).replace(/\n/g, " "));
  check("ofrece reenviar el enlace ahí mismo", /volver a enviarme el enlace/i.test(t));
  await page.click("text=Volver a enviarme el enlace");
  await page.waitForTimeout(1200);
  check("y confirma que lo reenvió", /te lo mandamos de nuevo/i.test(await texto(page)));

  // ═══════ 3. Abrir el enlace del correo ═══════
  console.log("\n── 3. Abrir el enlace de verificación ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(linkVerif, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  t = await texto(page);
  check("la página confirma el email", /quedó confirmado/i.test(t), t.slice(0, 80).replace(/\n/g, " "));
  check(
    "el token desaparece de la barra de direcciones",
    !page.url().includes("token="),
    page.url()
  );
  const sesion = await page.evaluate(() => localStorage.getItem("encuentro_token"));
  check("queda con la sesión abierta, sin volver a escribir la contraseña", Boolean(sesion));

  await page.goto(`${B}/historial`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("y el aviso de confirmar el email desaparece", !/falta confirmar tu email/i.test(await texto(page)));

  // ═══════ 4. Recuperar la contraseña ═══════
  console.log("\n── 4. Olvidé mi contraseña ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.click("text=¿Olvidaste tu contraseña?");
  await page.waitForTimeout(700);
  check("el enlace lleva a la pantalla de recuperación", page.url().includes("/recuperar"), page.url());

  await page.fill("#reset-email", email);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1300);
  t = await texto(page);
  check("dice que revise el correo", /revisá tu correo/i.test(t));
  check(
    "y no confirma ni desmiente que esa cuenta exista",
    /si hay una cuenta/i.test(t),
    t.slice(0, 80).replace(/\n/g, " ")
  );

  const linkReset = await linkFor(email, "/restablecer");
  check("llega el enlace para elegir contraseña nueva", Boolean(linkReset));

  // ═══════ 5. Elegir la contraseña nueva ═══════
  console.log("\n── 5. La pantalla de contraseña nueva ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(`${B}/restablecer`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  check("sin token, avisa que el enlace está incompleto", /enlace está incompleto/i.test(await texto(page)));

  await page.goto(linkReset, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("con el token, muestra el formulario", /elegí una contraseña nueva/i.test(await texto(page)));
  check("el token no queda en la barra de direcciones", !page.url().includes("token="), page.url());

  const NUEVA = "cerezo88Viento";
  await page.fill("#new-password", NUEVA);
  await page.fill("#confirm-new-password", "otraDistinta77");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(800);
  check("si no coinciden, lo dice y no cambia nada", /no coinciden/i.test(await texto(page)));

  await page.fill("#confirm-new-password", NUEVA);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  t = await texto(page);
  check("con las dos iguales, la cambia", /contraseña actualizada/i.test(t), t.slice(0, 80).replace(/\n/g, " "));
  check("y avisa que cerró las otras sesiones", /cerramos las sesiones/i.test(t));

  // ═══════ 6. Entrar con la nueva ═══════
  console.log("\n── 6. Entrar con la contraseña nueva ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.fill("#password", NUEVA);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  check("entra con la contraseña nueva", !page.url().includes("/ingresar"), page.url());

  await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${B}/ingresar`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1400);
  check("la contraseña vieja ya no entra", page.url().includes("/ingresar"), page.url());

  // ═══════ 7. Enlace ya usado ═══════
  console.log("\n── 7. Volver a abrir un enlace gastado ──");
  await ctx.close();
  ({ ctx, page } = await nuevaPagina());
  await page.goto(linkReset, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill("#new-password", "otroIntento44");
  await page.fill("#confirm-new-password", "otroIntento44");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  t = await texto(page);
  check("el enlace ya usado no sirve y lo explica", /venció o ya se usó|ya se usó/i.test(t), t.slice(0, 90).replace(/\n/g, " "));

  await page.goto(linkVerif, { waitUntil: "networkidle" });
  await page.waitForTimeout(1300);
  check(
    "reabrir el de verificación dice “ya estaba confirmado”, no un error",
    /ya estaba confirmado/i.test(await texto(page))
  );

  check("ninguna pantalla tiró un error de JavaScript", errores.length === 0, errores.slice(0, 2).join(" | "));

  await ctx.close();
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("ERROR:", e.message, e.stack?.slice(0, 300));
  process.exit(1);
});
