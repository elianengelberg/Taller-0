// GOOGLE MEET, EN VIVO Y EN LA PANTALLA DE UNIFY.
//
// Tres cosas que se reportaron de una reunión real y que acá se miran juntas,
// contra el stack real (servidor 4001, web 4174):
//   1. NO SE REPITE. Meet reescribe la misma fila mientras alguien habla, así
//      que la extensión manda «lo dicho + lo nuevo»: si el servidor lo tomara
//      como frases distintas, en pantalla aparecería el mismo párrafo tres
//      veces (pasó de verdad).
//   2. A TIEMPO. Lo que se está diciendo aparece mientras se habla (el camino
//      interino), no varios segundos después.
//   3. TRADUCIDO. Con un idioma elegido, cada frase se muestra traducida, y
//      el original queda debajo.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd3 = () => Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const CODIGO = `${rnd3()}-${rnd3()}${rnd3()[0]}-${rnd3()}`;
const SALA = `google-meet:${CODIGO}`;

// Lo que hace la extensión: postear la fila de subtítulos de Meet cada vez
// que crece (con lo anterior adentro), y lo interino mientras se habla.
const decir = (texto, extra = {}) =>
  fetch(`${API}/api/meet-bridge/${encodeURIComponent(SALA)}/transcript`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speaker: "Ana García", text: texto, lang: "es-AR", ...extra }),
  });

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: [] });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  // La reunión de Meet se abre en su app: acá sólo importa la capa de Unify.
  await p.route("**meet.google.com/**", (r) => r.fulfill({ status: 204 }));
  await p.route("**fonts.g**", (r) => r.abort());
  // El traductor del servidor necesita clave de IA (o el proveedor gratis, que
  // el arnés bloquea): se responde acá para probar el CABLEADO del cliente.
  const pedidosTraduccion = [];
  await p.route("**/api/translate", async (route) => {
    let texto = "";
    try { texto = JSON.parse(route.request().postData() || "{}").text || ""; } catch {}
    pedidosTraduccion.push(texto);
    // La traducción NO repite el original a propósito: así, contar cuántas
    // veces aparece la frase en pantalla mide repeticiones de verdad y no la
    // lectura doble (traducción arriba, original debajo) que es correcta.
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ translatedText: `TRADUCCION_${pedidosTraduccion.length}` }),
    });
  });

  await p.goto(`${B}/externa?url=${encodeURIComponent(`https://meet.google.com/${CODIGO}`)}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const nombre = p.getByLabel("Tu nombre");
  if (await nombre.count()) await nombre.first().fill("Testigo");
  const unirme = p.getByRole("button", { name: /Unirme/i }).first();
  if (await unirme.count()) await unirme.click();
  await p.waitForURL(/\/externa\/reunion/, { timeout: 20_000 }).catch(() => {});
  check("la capa de Unify de una reunión de Meet abre", p.url().includes("/externa/reunion"), p.url());
  await p.waitForTimeout(1500);

  console.log("\n── 1. Lo que se está diciendo aparece MIENTRAS se habla ──");
  {
    const t0 = Date.now();
    await decir("estamos arrancando con el informe", { interim: true });
    let visto = 0;
    for (let i = 0; i < 40 && !visto; i++) {
      if (await p.getByText(/estamos arrancando con el informe/).count()) visto = Date.now() - t0;
      else await sleep(150);
    }
    check("lo interino sale en menos de dos segundos (no se espera a que termine la frase)",
      visto > 0 && visto < 2000, visto ? `${visto} ms` : "no apareció");
  }

  console.log("\n── 2. Meet reescribe la fila: NO se repite el párrafo ──");
  {
    const A = "el informe del trimestre quedó cerrado ayer a la tarde";
    const B2 = "y las ventas subieron quince por ciento contra el año pasado";
    await decir(A);
    await sleep(1200);
    await decir(`${A} ${B2}`); // la fila de Meet, ya crecida
    await sleep(2500);
    const cuerpo = (await p.locator("body").innerText()) || "";
    const veces = (t) => cuerpo.split(t).length - 1;
    check("la primera parte aparece UNA sola vez (Meet la reescribió, no se repite)",
      veces(A) === 1, `veces=${veces(A)}`);
    check("y lo nuevo también, una sola vez", veces(B2) === 1, `veces=${veces(B2)}`);
    check("las dos partes quedaron en la MISMA frase (no dos tarjetas con lo mismo adentro)",
      cuerpo.includes(`${A} ${B2}`), cuerpo.slice(0, 0));
  }

  console.log("\n── 3. La traducción, con el original debajo ──");
  {
    // Se elige un idioma de destino en el selector de la barra.
    const selector = p.getByLabel(/Traducir a|idioma/i).first();
    if (await selector.count()) {
      await selector.selectOption({ label: /Ingl(é|e)s/ }).catch(async () => {
        const valores = await selector.evaluate((s) => Array.from(s.options).map((o) => o.value));
        const en = valores.find((v) => v.startsWith("en"));
        if (en) await selector.selectOption(en);
      });
    }
    await sleep(600);
    // Otra persona y una pausa larga: una frase NUEVA, no la fusión de la
    // anterior (que es lo correcto cuando alguien sigue hablando).
    await sleep(2600);
    await fetch(`${API}/api/meet-bridge/${encodeURIComponent(SALA)}/transcript`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker: "Bruno Pérez", text: "cerramos el presupuesto el jueves con todo el equipo", lang: "es-AR" }),
    });
    let traducido = false;
    for (let i = 0; i < 50 && !traducido; i++) {
      traducido = (await p.getByText(/^TRADUCCION_\d+$/).count()) > 0;
      if (!traducido) await sleep(200);
    }
    check("la frase se muestra TRADUCIDA (la traducción es la lectura principal)",
      traducido, `pedidos=${pedidosTraduccion.length}`);
    check("y el original queda a la vista debajo",
      (await p.getByText(/cerramos el presupuesto el jueves/).count()) >= 1);
    check("se le pidió al servidor la traducción de lo que se dijo",
      pedidosTraduccion.some((t) => /presupuesto/.test(t)), pedidosTraduccion.join(" | ").slice(0, 120));
  }

  check("sin errores de JavaScript en toda la reunión", errs.length === 0, errs[0] || "");
  await browser.close();
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} OK`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
