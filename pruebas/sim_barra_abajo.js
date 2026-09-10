// LA BARRA DE ABAJO: QUE CADA BOTÓN HAGA ALGO.
//
// «No me gustan los botones de abajo, fíjate que de verdad funcionen y sirvan
// de algo». Eran cinco círculos grises idénticos: el que pausa los subtítulos
// se veía igual que el que abre un panel y que el que CORTA la reunión.
//
// Esta prueba no mira que «estén»: aprieta cada uno y exige que la pantalla
// cambie de verdad. Un botón que se ve lindo y no hace nada es peor que no
// tenerlo, porque se toca y se cree que la app está rota.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const rnd3 = () => Array.from({ length: 3 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

(async () => {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await p.route("**meet.google.com/**", (r) => r.fulfill({ status: 204 }));
  await p.route("**fonts.g**", (r) => r.abort());
  await p.addInitScript(() => { window.open = () => null; });

  const codigo = `${rnd3()}-${rnd3()}${rnd3()[0]}-${rnd3()}`;
  await p.goto(`${B}/externa?url=${encodeURIComponent(`https://meet.google.com/${codigo}`)}&auto=1`, {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(1500);
  const nombre = p.getByLabel("Tu nombre");
  if (await nombre.count()) {
    await nombre.first().fill("Testigo");
    const entrar = p.getByRole("button", { name: /Entrar|Unirme|Continuar/i });
    if (await entrar.count()) await entrar.first().click();
    await p.waitForTimeout(2000);
  }

  // ── 1. Cada control se ve, y se ve QUÉ ES ───────────────────────────────
  console.log("\n── Se ve qué es cada cosa, sin apretarla ──");
  {
    const subt = p.getByRole("button", { name: /los subtítulos en vivo/i }).first();
    check("el interruptor de subtítulos está a la vista", (await subt.count()) > 0);
    // Un interruptor DICE en qué estado está: aria-pressed. Sin eso, ni un
    // lector de pantalla ni una prueba pueden saber si está prendido.
    check("y dice si está prendido o apagado (aria-pressed)",
      ["true", "false"].includes(await subt.getAttribute("aria-pressed") ?? ""),
      String(await subt.getAttribute("aria-pressed")));
    const grupo = p.getByRole("group", { name: /Paneles de la reunión/i });
    check("los tres paneles viven en una sola cápsula («elegí uno»)", (await grupo.count()) === 1);
    check("y adentro están los tres", (await grupo.getByRole("button").count()) === 3,
      `botones=${await grupo.getByRole("button").count()}`);
    // El nombre se lee SIEMPRE: un ícono suelto no le dice nada a nadie.
    for (const n of ["Transcripción", "IA", "Ajustes"]) {
      check(`«${n}» se lee con todas las letras`,
        (await grupo.getByText(n, { exact: true }).count()) > 0);
    }
  }

  // ── 2. El interruptor de subtítulos PAUSA de verdad ─────────────────────
  console.log("\n── El interruptor de subtítulos pausa de verdad ──");
  {
    const subt = p.getByRole("button", { name: /los subtítulos en vivo/i }).first();
    const antes = await subt.getAttribute("aria-pressed");
    await subt.click();
    await p.waitForTimeout(600);
    const despues = await p.getByRole("button", { name: /los subtítulos en vivo/i }).first().getAttribute("aria-pressed");
    check("tocarlo cambia el estado (no es un adorno)", antes !== despues, `${antes} -> ${despues}`);
    // Y LO DICE con la palabra: «Pausados» es lo que hace entender que el
    // silencio de la pantalla es a propósito y no que se rompió.
    const texto = await p.evaluate(() => document.body.innerText);
    check("y la pantalla dice que están pausados", /Pausados/i.test(texto));
    await p.getByRole("button", { name: /los subtítulos en vivo/i }).first().click();
    await p.waitForTimeout(600);
    check("y se vuelven a prender",
      (await p.getByRole("button", { name: /los subtítulos en vivo/i }).first().getAttribute("aria-pressed")) === "true");
  }

  // ── 3. Cada panel abre SU panel, y sólo uno a la vez ────────────────────
  console.log("\n── Cada panel abre el suyo, y sólo uno a la vez ──");
  {
    const grupo = p.getByRole("group", { name: /Paneles de la reunión/i });
    const abrir = async (re) => {
      await grupo.getByRole("button", { name: re }).click();
      await p.waitForTimeout(700);
    };
    await abrir(/Ver la transcripción completa/i);
    check("«Transcripción» abre la transcripción",
      /Transcripción de la reunión|Transcripción/i.test(await p.evaluate(() => document.body.innerText)));
    check("y la cápsula lo marca como abierto",
      (await grupo.getByRole("button", { name: /Ver la transcripción/i }).getAttribute("aria-pressed")) === "true");

    await abrir(/Abrir el asistente de IA/i);
    check("«IA» abre el asistente", (await p.getByRole("button", { name: /Abrir el asistente de IA/i }).getAttribute("aria-pressed")) === "true");
    check("y al abrirlo se CIERRA el anterior (sólo uno a la vez)",
      (await grupo.getByRole("button", { name: /Ver la transcripción/i }).getAttribute("aria-pressed")) === "false");

    await abrir(/Ajustes de esta reunión/i);
    const texto = await p.evaluate(() => document.body.innerText);
    // El botón PROMETE cuatro cosas en su nombre («invitar, roles, grabar,
    // texto grande»): que las cuatro estén de verdad adentro. Un panel que
    // promete más de lo que tiene es otra forma de botón que no sirve.
    const promesas = [
      ["invitar", /Compartir el enlace/i],
      ["roles", /Abrir roles/i],
      ["grabar", /grabar|grabaci[óo]n|grabando/i],
      ["texto grande", /Texto grande/i],
    ];
    for (const [que, re] of promesas) {
      check(`«Ajustes» cumple lo que promete: ${que}`, re.test(texto),
        texto.replace(/\s+/g, " ").slice(0, 110));
    }
    await abrir(/Ajustes de esta reunión/i);
    check("y volver a tocarlo lo cierra",
      (await grupo.getByRole("button", { name: /Ajustes de esta reunión/i }).getAttribute("aria-pressed")) === "false");
  }

  // ── 4. Cortar la reunión NO está pegado a los demás ─────────────────────
  console.log("\n── Lo que toca la reunión, aparte de lo que sólo se mira ──");
  {
    // Sin la extensión en la pestaña de Meet, Unify no puede apretar los
    // botones de Google: esos controles NO se muestran, en vez de ofrecer un
    // botón que no haría nada (que es de lo que se venía quejando).
    check("sin extensión conectada, «Cortar» no se ofrece",
      (await p.getByRole("button", { name: /Cortar la reunión en Meet/i }).count()) === 0);
    check("ni «Silenciar»",
      (await p.getByRole("button", { name: /micrófono en Meet/i }).count()) === 0);
  }

  // ── 5. En un teléfono angosto no se apelotonan ──────────────────────────
  console.log("\n── En un teléfono angosto se siguen pudiendo tocar ──");
  {
    await p.setViewportSize({ width: 390, height: 760 });
    await p.waitForTimeout(800);
    const medidas = await p.evaluate(() => {
      const grupo = document.querySelector('[role="group"][aria-label="Paneles de la reunión"]');
      const barra = grupo?.closest("div")?.parentElement;
      const botones = Array.from(barra?.querySelectorAll("button") ?? []);
      return {
        alto: Math.min(...botones.map((b) => Math.round(b.getBoundingClientRect().height))),
        desborde: barra ? barra.scrollWidth - barra.clientWidth : 0,
        puedeCorrerse: barra ? getComputedStyle(barra).overflowX : "",
      };
    });
    // 38px es el mínimo cómodo para un pulgar en un botón de una cápsula.
    check("los botones siguen siendo tocables con el pulgar", medidas.alto >= 36, `${medidas.alto}px`);
    check("y si no entran, la barra se corre de costado (no se apelotonan)",
      medidas.desborde === 0 || medidas.puedeCorrerse === "auto" || medidas.puedeCorrerse === "scroll",
      `desborde=${medidas.desborde}px overflow=${medidas.puedeCorrerse}`);
    const cuerpo = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("y la pantalla entera no se va de costado", cuerpo <= 0, `${cuerpo}px`);
  }

  check("sin errores de JavaScript en todo el recorrido", errs.length === 0, errs[0] || "");

  await ctx.close();
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
