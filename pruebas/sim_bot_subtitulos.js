// EL BOT LEE LOS SUBTÍTULOS DE GOOGLE, NO ADIVINA.
//
// Reporte de una reunión real, con la captura en la mano: el bot escribió
// «Amanda's» donde nadie dijo nada parecido, y todo firmado «Unify
// Notetaker». La causa: transcribía con el reconocimiento del navegador sobre
// una MEZCLA de todos los audios de la reunión -- varias voces sumadas,
// recomprimidas y sin saber cuál es cuál. Es lo peor de los dos mundos.
//
// Pero el bot está ADENTRO del Meet, con un Chrome de verdad, y Google ya
// transcribe esa misma reunión sobre la pista limpia de cada participante y
// sabiendo quién habla. Acá se prueba el lector de esos subtítulos contra un
// Meet falso que se comporta como el de verdad: los CC arrancan APAGADOS, y
// la fila se REESCRIBE mientras la persona habla (que es lo que hacía que la
// transcripción se llenara de la misma frase creciendo de a pedacitos).
const fs = require("fs");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

// El cuerpo REAL del lector, sacado del bot: si alguien lo cambia, esta
// prueba prueba el cambio. Copiarlo acá a mano sería probar una copia.
function cuerpoDelLector() {
  const src = fs.readFileSync("/home/user/Taller-0/bot/joinbot.mjs", "utf8");
  const m = src.match(/const ok = await page\.evaluate\(\(\) => \{\n([\s\S]*?)\n  \}\)\.catch\(\(\) => false\);/);
  if (!m) throw new Error("no encontré el lector de subtítulos en bot/joinbot.mjs");
  return `(() => {\n${m[1]}\n})()`;
}

// Un Meet falso: botón CC apagado, y una región de subtítulos que aparece
// recién cuando se lo aprieta -- como el de verdad.
const PAGINA = `<!doctype html><html lang="es"><body style="margin:0;background:#202124">
  <button aria-label="Salir de la llamada">call_end</button>
  <button id="cc" aria-label="Activar subtítulos" aria-pressed="false">closed_caption_off</button>
  <script>
    window.__ccClics = 0;
    document.getElementById("cc").addEventListener("click", () => {
      window.__ccClics += 1;
      const b = document.getElementById("cc");
      b.setAttribute("aria-label", "Desactivar subtítulos");
      b.setAttribute("aria-pressed", "true");
      b.textContent = "closed_caption";
      if (document.getElementById("caps")) return;
      const r = document.createElement("div");
      r.id = "caps";
      r.setAttribute("role", "region");
      r.setAttribute("aria-label", "Subtítulos");
      document.body.appendChild(r);
    });
    // Meet escribe la fila de a pedacitos, reescribiéndola entera cada vez.
    window.__decir = async (quien, frase) => {
      const caps = document.getElementById("caps");
      const fila = document.createElement("div");
      fila.innerHTML = '<img alt=""><span class="n"></span><span class="t"></span>';
      caps.appendChild(fila);
      fila.querySelector(".n").textContent = quien;
      const t = fila.querySelector(".t");
      const palabras = frase.split(" ");
      for (let i = 1; i <= palabras.length; i++) {
        t.textContent = palabras.slice(0, i).join(" ");
        await new Promise((r) => setTimeout(r, 40));
      }
      return fila;
    };
  </script>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
  await page.route("**/*", (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGINA })
  );
  await page.goto("http://meet.falso/abc-defg-hij", { waitUntil: "domcontentloaded" });

  // Los dos puentes hacia Node, espiados: lo PUBLICADO y lo que se está
  // diciendo en vivo. Van aparte porque contar lo interino como frase
  // publicada haría ver repeticiones donde no se repite nada.
  await page.evaluate(() => {
    window.__lineas = [];
    window.__interinos = [];
    window.botEmit = (texto, alts, quien) => window.__lineas.push({ texto, quien });
    window.botEmitInterino = (texto, quien) => window.__interinos.push({ texto, quien });
  });

  // ── 1. Los enciende solo ───────────────────────────────────────────────
  console.log("\n── El bot enciende los subtítulos de Meet ──");
  const listo = await page.evaluate(cuerpoDelLector());
  check("los subtítulos arrancaban APAGADOS y el bot los prendió",
    (await page.evaluate(() => window.__ccClics)) >= 1);
  check("y queda leyéndolos", listo === true, String(listo));

  // ── 2. Lee lo que dice cada persona, CON SU NOMBRE ─────────────────────
  console.log("\n── Lee lo que dijo cada persona, con su nombre ──");
  await page.evaluate(() => window.__decir("Elian", "hola qué tal cómo andan todos por ahí"));
  await page.waitForTimeout(2600);
  const lineas1 = await page.evaluate(() => window.__lineas);
  check("la frase llegó entera", lineas1.some((l) => /cómo andan todos por ahí/.test(l.texto)),
    JSON.stringify(lineas1).slice(0, 140));
  check("Y FIRMADA POR QUIEN LA DIJO (no «Unify Notetaker» ni «la reunión»)",
    lineas1.some((l) => l.quien === "Elian"), JSON.stringify(lineas1.map((l) => l.quien)));
  check("y mientras se hablaba ya viajaba lo que se estaba diciendo",
    (await page.evaluate(() => window.__interinos.length)) > 0);

  // ── 3. La misma fila creciendo no se manda tres veces ──────────────────
  console.log("\n── Meet reescribe la fila: se manda sólo lo nuevo ──");
  const antes = await page.evaluate(() => window.__lineas.length);
  await page.evaluate(async () => {
    const caps = document.getElementById("caps");
    const fila = document.createElement("div");
    fila.innerHTML = '<img alt=""><span class="n">Ana</span><span class="t"></span>';
    caps.appendChild(fila);
    const t = fila.querySelector(".t");
    // Primero se asienta un pedazo, y DESPUÉS la misma fila sigue creciendo.
    t.textContent = "arranquemos con el presupuesto";
    await new Promise((r) => setTimeout(r, 2200));
    t.textContent = "arranquemos con el presupuesto y después vemos los plazos";
  });
  await page.waitForTimeout(2600);
  const nuevas = (await page.evaluate(() => window.__lineas)).slice(antes);
  const texto = nuevas.map((l) => l.texto).join(" | ");
  check("lo ya dicho no se vuelve a mandar",
    (texto.match(/arranquemos con el presupuesto/g) || []).length === 1, texto.slice(0, 140));
  check("y la continuación sí llega", /después vemos los plazos/.test(texto), texto.slice(0, 140));

  // ── 4. La interfaz de Meet no es una voz ───────────────────────────────
  console.log("\n── Los botones y los íconos de Meet no son voces ──");
  const antes2 = await page.evaluate(() => window.__lineas.length);
  await page.evaluate(async () => {
    const caps = document.getElementById("caps");
    // El botón «Ir al final» de Meet, con su ícono escrito como texto, y un
    // cartel con enlace: ninguno de los dos lo dijo nadie.
    const boton = document.createElement("div");
    boton.innerHTML = '<button aria-label="Ir al final"><img alt="">arrow_downward</button>';
    caps.appendChild(boton);
    const cartel = document.createElement("div");
    cartel.innerHTML = '<img alt=""><span>Meet</span><a href="https://support.google.com/meet">Más información</a>';
    caps.appendChild(cartel);
    await new Promise((r) => setTimeout(r, 100));
  });
  await page.waitForTimeout(2600);
  const basura = (await page.evaluate(() => window.__lineas)).slice(antes2);
  check("ni el botón ni su ícono entran a la transcripción",
    !basura.some((l) => /arrow_downward|Ir al final/.test(l.texto)),
    JSON.stringify(basura).slice(0, 140) || "nada enviado");
  check("ni un cartel con enlace", !basura.some((l) => /Más información|support\.google/.test(l.texto)),
    JSON.stringify(basura).slice(0, 140) || "nada enviado");

  // ── 5. Si Meet los apaga, vuelve a prenderlos ──────────────────────────
  console.log("\n── Si Meet apaga los subtítulos, el bot insiste ──");
  const clicsAntes = await page.evaluate(() => window.__ccClics);
  await page.evaluate(() => {
    document.getElementById("caps")?.remove();
    const b = document.getElementById("cc");
    b.setAttribute("aria-label", "Activar subtítulos");
    b.setAttribute("aria-pressed", "false");
    b.textContent = "closed_caption_off";
  });
  await page.waitForTimeout(15_000);
  check("los vuelve a prender solo (no se rinde en el primer intento)",
    (await page.evaluate(() => window.__ccClics)) > clicsAntes,
    `clics=${await page.evaluate(() => window.__ccClics)}`);
  const antes3 = await page.evaluate(() => window.__lineas.length);
  await page.evaluate(() => window.__decir("Bruno", "y ahora se tiene que volver a escuchar"));
  await page.waitForTimeout(2600);
  check("y vuelve a transcribir",
    (await page.evaluate(() => window.__lineas)).slice(antes3).some((l) => /volver a escuchar/.test(l.texto)));

  check("sin errores de JavaScript", errs.length === 0, errs[0] || "");

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
