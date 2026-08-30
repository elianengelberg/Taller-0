// Carga la EXTENSIÓN REAL en Chromium real (sin stubs de chrome.*) y la prueba
// contra un Meet simulado que reescribe los subtítulos como lo hace Google.
// Se prueba una COPIA de la extensión cuyo manifest apunta también a localhost;
// el manifest que se publica no se toca.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");

const SRC = "/home/user/Taller-0/extension";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Meet falso</title></head>
<body style="margin:0;background:#202124;height:100vh">
  <button aria-label="Salir de la llamada">Salir</button>
  <button aria-label="Mostrar a todos (3)">Personas</button>
  <div data-is-muted="false" aria-label="Desactivar micrófono"></div>
  <div data-is-muted="false" aria-label="Desactivar cámara"></div>
  <div role="region" aria-label="Subtítulos" id="caps"></div>
  <script>
    // Capturamos lo que la extensión envía al backend de Unify.
    window.__posted = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/transcript")) {
        try { window.__posted.push(JSON.parse(opts.body)); } catch {}
        return new Response(JSON.stringify({ ok: true, dbId: "fake" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/session")) {
        return new Response(JSON.stringify({ dbId: "fake", transcript: [], participants: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/translate")) {
        return new Response(JSON.stringify({ translatedText: "TRADUCIDO" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return realFetch(url, opts);
    };
    const caps = document.getElementById("caps");
    window.__say = async (speaker, full) => {
      const row = document.createElement("div");
      row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
      caps.appendChild(row);
      row.querySelector(".n").textContent = speaker;
      const t = row.querySelector(".t");
      const words = full.split(" ");
      for (let i = 1; i <= words.length; i++) {
        t.textContent = words.slice(0, i).join(" ");
        await new Promise((r) => setTimeout(r, 30));
      }
    };
  </script>
</body></html>`;

(async () => {
  // --- Copia de la extensión con el manifest apuntando también a localhost ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unify-ext-"));
  // Copia RECURSIVA: el manifest declara icons/16.png etc., y si la copia
  // pierde la carpeta icons/, Chrome muestra el modal "Failed to load
  // extension" y el navegador nunca llega a estar listo (Playwright revienta
  // por timeout de arranque, sin una sola prueba corrida).
  fs.cpSync(SRC, dir, { recursive: true });
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const LOCAL = "http://localhost:4189/*";
  man.host_permissions.push(LOCAL);
  man.content_scripts[0].matches.push(LOCAL);
  man.web_accessible_resources.forEach((r) => r.matches.push(LOCAL));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(man, null, 2));

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(4189, r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unify-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: false, // las extensiones necesitan modo con ventana (corre bajo xvfb)
    args: [
      "--no-sandbox",
      // El entorno define HTTPS_PROXY y Chromium lo hereda; acá todo vive en
      // localhost y el proxy sólo aporta cuelgues en el arranque. Directo.
      "--no-proxy-server",
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  // El service worker de MV3 confirma que la extensión cargó de verdad.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("la extensión CARGA en Chromium real (service worker activo)", Boolean(sw), sw ? sw.url().split("/").pop() : "no arrancó");

  // El content script vive en un mundo aislado: hay que interceptar en el
  // navegador, no pisando window.fetch de la página.
  const posted = [];
  // Lo que el servidor de VERDAD contesta: el texto ya corregido por la IA y,
  // si Meet está escribiendo en otro idioma, cuál. `respuestaIA` deja que una
  // prueba puntual encienda ese comportamiento.
  let respuestaIA = null;
  await ctx.route("**/api/meet-bridge/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/transcript")) {
      let cuerpo = {};
      try { cuerpo = JSON.parse(route.request().postData() || "{}"); posted.push(cuerpo); } catch {}
      const extra = respuestaIA ? respuestaIA(cuerpo) : null;
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, dbId: "fake", ...(extra || {}) }),
      });
    }
    if (url.endsWith("/session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dbId: "fake", transcript: [], participants: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await ctx.route("**/api/translate", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translatedText: "we need to approve the budget" }) })
  );

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  await page.goto("http://localhost:4189/abc-defg-hij", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // EL AVISO EN MEET. Faltaba: el panel montaba colapsado (un botón chico en
  // la barra de Google) y quien creaba una reunión instantánea no veía NADA y
  // creía que la extensión no funcionaba. Ahora avisa igual que en Zoom.
  {
    const aviso = page.locator("#unify-aviso");
    check("en Meet aparece el aviso de Unify (no sólo un botón escondido)",
      (await aviso.count()) === 1);
    // Sólo el texto de la caja: shadowRoot.textContent incluiría el CSS y el
    // detalle del PASS quedaría lleno de estilos en vez del mensaje real.
    const texto = await aviso
      .evaluate((el) => el.shadowRoot?.querySelector(".caja")?.textContent?.trim() ?? "")
      .catch(() => "");
    check("dice qué ofrece y avisa que arranca solo",
      /reunión de Google Meet/.test(texto) && /subtítulos y grabar/.test(texto) && /abro los subtítulos solo/.test(texto),
      texto.slice(0, 80));

    // EN EL MEDIO Y GRANDE: en el rincón de abajo a la derecha se perdía
    // entre los controles de Meet y no se llegaba a leer.
    // Se mide contra la ventana REAL (el arnés no fija un viewport propio).
    const caja = await aviso.evaluate((el) => {
      const c = el.shadowRoot?.querySelector(".caja");
      const r = c?.getBoundingClientRect();
      if (!r) return null;
      return {
        w: r.width,
        desvioX: Math.abs(r.x + r.width / 2 - window.innerWidth / 2),
        desvioY: Math.abs(r.y + r.height / 2 - window.innerHeight / 2),
      };
    });
    check("el aviso está en el MEDIO de la pantalla (no en un rincón)",
      Boolean(caja) && caja.desvioX < 40 && caja.desvioY < 40,
      caja ? `desvío=(${Math.round(caja.desvioX)},${Math.round(caja.desvioY)}) px del centro` : "sin caja");
    check("y es grande de verdad (se lee de un vistazo)", Boolean(caja) && caja.w >= 480,
      caja ? `${Math.round(caja.w)}px` : "sin caja");

    // El fondo NO puede robarle los clics a Meet: tapar "Unirse ahora" quince
    // segundos sería peor que el cartel chiquito.
    check("y Meet se sigue usando atrás (el fondo del aviso no intercepta clics)",
      await page.evaluate(() => document.getElementById("unify-aviso")?.style.pointerEvents === "none"));

    // QUINCE segundos, no cinco: a los 6 todavía tiene que estar esperando.
    await page.waitForTimeout(6500);
    check("a los 6 segundos TODAVÍA espera tu respuesta (antes se iba a los 5)",
      (await page.locator("#unify-aviso").count()) === 1);

    // Y si no contesta, hace todo solo: abre los subtítulos.
    await page.waitForTimeout(10_000);
    check("sin respuesta, a los 15 segundos el panel se abre solo",
      await page.evaluate(() =>
        Boolean(document.getElementById("unify-root")?.shadowRoot?.querySelector(".drawer.is-open"))
      ));
    check("y el aviso se va cuando ya cumplió su función",
      (await page.locator("#unify-aviso").count()) === 0);
  }

  check("inyecta el panel con Shadow DOM", (await page.locator("#unify-root").count()) > 0);
  const shadowOk = await page.evaluate(() => Boolean(document.getElementById("unify-root")?.shadowRoot));
  check("el panel usa Shadow DOM aislado (no lo rompe el CSS de Meet)", shadowOk);
  check("badge de estado presente", (await page.locator(".badge").count()) > 0);
  check("cajón lateral con 3 pestañas", (await page.locator(".drawer .tab").count()) === 3);

  // --- LOS CONTROLES SE TIENEN QUE VER ---------------------------------------
  // El panel flota sobre el video de Meet: un glifo gris sin fondo (así eran
  // los botones) directamente desaparece. Y el desplegable del idioma salía
  // BLANCO SOBRE BLANCO -- no se leía ni una opción.
  {
    const medir = (sel) => page.evaluate((s) => {
      const n = document.getElementById("unify-root")?.shadowRoot?.querySelector(s);
      if (!n) return null;
      const c = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return {
        w: r.width, h: r.height, texto: (n.textContent || "").trim().slice(0, 20),
        fondo: c.backgroundColor, borde: c.borderTopWidth, color: c.color,
        esquema: c.colorScheme,
      };
    }, sel);

    const traducir = await medir(".badge .langsel");
    check("el control de TRADUCIR está a la vista y se entiende",
      Boolean(traducir) && traducir.w >= 60 && traducir.h >= 26,
      traducir ? `${Math.round(traducir.w)}x${Math.round(traducir.h)}` : "no está");
    check("y dice «Traducir» con todas las letras (antes sólo decía «EN»)",
      /Traducir/i.test(await page.locator(".badge").textContent() || ""));
    check("su lista de idiomas ya NO sale blanca sobre blanco",
      Boolean(traducir) && /dark/.test(traducir.esquema || ""), traducir?.esquema);

    const grabar = await medir(".recbtn");
    check("el botón de grabar se ve (tiene superficie, borde y nombre)",
      Boolean(grabar) && grabar.w >= 80 && grabar.h >= 30 &&
      grabar.fondo !== "rgba(0, 0, 0, 0)" && parseFloat(grabar.borde) > 0 && /Grabar/i.test(grabar.texto),
      grabar ? `${Math.round(grabar.w)}x${Math.round(grabar.h)} fondo=${grabar.fondo} "${grabar.texto}"` : "no está");

    const cerrar = await medir(".iconbtn");
    check("y el de cerrar también (no un glifo suelto en gris)",
      Boolean(cerrar) && cerrar.fondo !== "rgba(0, 0, 0, 0)" && parseFloat(cerrar.borde) > 0,
      cerrar ? `fondo=${cerrar.fondo}` : "no está");
  }

  // --- Conversación real de 3 personas ---
  await page.evaluate(() => window.__say("Ana García", "buenos días equipo, arrancamos con el presupuesto"));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__say("Bruno Pérez", "yo tengo los números del trimestre listos"));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__say("Carolina Díaz", "diseño necesita dos semanas más"));
  await page.waitForTimeout(2400);

  // EL BOTÓN DE MEET NO ES UN PARTICIPANTE. Meet mete su propio botón "Ir al
  // final" adentro de la región de subtítulos, y los íconos de Material se
  // escriben como TEXTO ("arrow_downward"): la transcripción terminaba con un
  // participante llamado "arrow_downward" diciendo "Ir al final". Pasó de
  // verdad, en una reunión real.
  {
    const antes = posted.length;
    await page.evaluate(() => {
      const fila = document.createElement("div");
      fila.innerHTML =
        '<button aria-label="Ir al final"><i class="google-symbols">arrow_downward</i>' +
        '<span>Ir al final</span></button>';
      document.getElementById("caps").appendChild(fila);
    });
    await page.waitForTimeout(2500);
    const nuevas = posted.slice(antes);
    check("el botón «Ir al final» de Meet NO entra como si alguien lo hubiera dicho",
      nuevas.length === 0,
      nuevas.map((p) => `${p.speaker}: ${p.text}`).join(" | ") || "ninguna línea nueva");
  }

  // Y LOS ÍCONOS SUELTOS TAMPOCO. La segunda vez que pasó, el "comando" no
  // venía adentro de un botón: era un span de ícono pelado ("mic", "chat" en
  // la fuente de símbolos, o marcado aria-hidden). Una sola palabra sin guion
  // bajo se le escapaba a la regla vieja.
  {
    const antes = posted.length;
    await page.evaluate(() => {
      const fila = document.createElement("div");
      fila.innerHTML =
        '<i class="google-symbols">mic</i>' +
        '<span aria-hidden="true">volume_up</span>' +
        '<span class="notranslate material-icons-extended">chat</span>' +
        '<i>send</i>';
      document.getElementById("caps").appendChild(fila);
    });
    await page.waitForTimeout(2500);
    const nuevas = posted.slice(antes);
    check("los íconos sueltos de Meet (mic, chat, send…) NO entran a la transcripción",
      nuevas.length === 0,
      nuevas.map((p) => `${p.speaker}: ${p.text}`).join(" | ") || "ninguna línea nueva");
  }

  // EL BOTÓN "U" YA NO VIVE ADENTRO DE LA BARRA DE MEET. Inyectarlo ahí
  // (bar.appendChild) rompía los botones de Meet cuando su framework
  // re-renderizaba la barra: mutear y apagar cámara quedaban "completamente
  // bugueados" (pasó en una reunión real). Ahora es un flotante del shadow.
  {
    const donde = await page.evaluate(() => ({
      enBarraDeMeet: Boolean(document.getElementById("unify-bar-btn")),
      enShadow: Boolean(document.getElementById("unify-root")?.shadowRoot?.querySelector(".fab")),
    }));
    check("el botón «U» NO se inyecta en el DOM de Meet (no le rompe la botonera)",
      donde.enBarraDeMeet === false, donde.enBarraDeMeet ? "sigue adentro de la barra" : "limpio");
    check("y vive como flotante en el shadow de Unify", donde.enShadow === true);

    // Y abre/cierra el panel de verdad.
    const abierto = await page.evaluate(() => {
      const shadow = document.getElementById("unify-root").shadowRoot;
      // A estado conocido POR EL CAMINO REAL (tocar la clase desincronizaría
      // el estado interno del panel).
      if (shadow.querySelector(".drawer.is-open")) shadow.querySelector('[data-el="close"]').click();
      shadow.querySelector(".fab").click();
      return Boolean(shadow.querySelector(".drawer.is-open"));
    });
    check("el flotante «U» abre el panel", abierto === true);
    const cerrado = await page.evaluate(() => {
      const shadow = document.getElementById("unify-root").shadowRoot;
      shadow.querySelector('[data-el="close"]').click();
      return !shadow.querySelector(".drawer.is-open");
    });
    check("y la ✕ del panel lo vuelve a cerrar", cerrado === true);
  }

  const speakers = [...new Set(posted.map((p) => p.speaker))];
  check("transcribe a TODOS los participantes", speakers.length === 3, speakers.join(" | "));
  check("una frase por persona, sin duplicados", posted.length === 3, `enviadas=${posted.length}`);
  check("las frases salen completas", posted.every((p) => p.text.split(" ").length >= 5),
    posted.map((p) => `"${p.text}"`).join(" / "));

  const subs = await page.locator(".subs").textContent();
  check("los subtítulos se ven sobre el video", /Carolina|diseño/.test(subs || ""), (subs || "").replace(/\s+/g, " ").slice(0, 70));

  const stream = await page.locator(".stream").textContent();
  check("la transcripción del panel muestra a los tres", ["Ana", "Bruno", "Carolina"].every((n) => (stream || "").includes(n)));

  // EL CARTEL SOBRE EL VIDEO NO PUEDE TAPAR LA PANTALLA. Sin techo de alto,
  // un texto largo lo estiraba hasta cubrir media reunión por encima del
  // video. Es un subtítulo: entra una idea, no la charla entera.
  {
    await page.evaluate(async () => {
      const largo = ("esto es una frase larguísima que sigue y sigue sin parar y no termina nunca jamás ")
        .repeat(14);
      await window.__say("Lucía Vera", largo);
    });
    await page.waitForTimeout(2000);
    const caja = await page.evaluate(() => {
      const n = document.getElementById("unify-root").shadowRoot.querySelector(".subs");
      const r = n.getBoundingClientRect();
      return { alto: r.height, pantalla: window.innerHeight };
    });
    check("el cartel sobre el video se mantiene chico (no tapa la reunión)",
      caja.alto <= caja.pantalla * 0.35,
      `${Math.round(caja.alto)}px de ${caja.pantalla}px de pantalla`);
  }

  // LA IA CORRIGE Y EL PANEL LO MUESTRA. El servidor reconstruye la frase más
  // probable, pero antes esa versión sólo iba al historial: en pantalla
  // quedaba la lectura cruda del reconocimiento. Se veía la peor de las dos.
  {
    respuestaIA = (cuerpo) => ({
      text: cuerpo.text.replace(/comandantes/i, "cómo andás"),
      idiomaDistinto: "en",
    });
    await page.evaluate(() => window.__say("Nadia Sosa", "contame un poco comandantes todo bien"));
    await page.waitForTimeout(3200);
    const enPantalla = await page.evaluate(() =>
      [...document.getElementById("unify-root").shadowRoot.querySelectorAll(".entry .text")]
        .map((n) => n.textContent).join(" | "));
    check("el panel adopta la frase corregida por la IA (no la lectura cruda)",
      /cómo andás/i.test(enPantalla) && !/comandantes/i.test(enPantalla),
      (enPantalla.match(/[^|]*(cómo andás|comandantes)[^|]*/i)?.[0] ?? "").trim().slice(0, 70));

    // Y si Meet escribe en otro idioma, se dice con nombre: es LA causa de
    // que las palabras salgan mal, y ninguna IA la arregla después.
    const aviso = await page.evaluate(() =>
      document.getElementById("unify-root").shadowRoot.querySelector(".hint")?.textContent ?? "");
    check("y avisa, con el idioma detectado, por qué salen palabras raras",
      /inglés/i.test(aviso) && /CC/.test(aviso), aviso.trim().slice(0, 90));
    respuestaIA = null;
  }

  // NADA DE MUROS DE TEXTO. En una reunión de verdad el panel terminaba con
  // UNA tarjeta de miles de caracteres: todo lo dicho en minutos pegado, sin
  // hora propia y sin dónde apoyar el ojo. La transcripción tiene que leerse
  // como una conversación.
  {
    await page.evaluate(async () => {
      const caps = document.getElementById("caps");
      const decir = async (texto) => {
        const row = document.createElement("div");
        row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
        caps.appendChild(row);
        row.querySelector(".n").textContent = "Sofía Lema";
        row.querySelector(".t").textContent = texto;
        await new Promise((r) => setTimeout(r, 2200));
      };
      await decir("Arrancamos con el informe del trimestre. Las ventas subieron un quince por ciento contra el año pasado. El equipo de soporte cerró todos los tickets pendientes.");
      await decir("Ahora bien, hay un tema con los plazos de entrega que quiero discutir con ustedes porque viene arrastrándose desde marzo y ya nos costó dos clientes importantes.");
    });
    await page.waitForTimeout(3000);
    const tarjetas = await page.evaluate(() =>
      [...document.getElementById("unify-root").shadowRoot.querySelectorAll(".entry .text")].map((n) => n.textContent.trim()));
    const deSofia = tarjetas.filter((t) => /trimestre|ventas|soporte|plazos|clientes/i.test(t));
    const masLarga = Math.max(0, ...deSofia.map((t) => t.length));
    check("un discurso largo se parte en tarjetas legibles (no un muro de texto)",
      deSofia.length >= 3 && masLarga <= 260,
      `${deSofia.length} tarjetas, la más larga de ${masLarga} caracteres`);
    check("y cada frase queda entera (no cortada al medio de una palabra)",
      deSofia.every((t) => !/\s$/.test(t) && t.length > 0),
      deSofia.map((t) => `«${t.slice(0, 38)}…»`).join(" "));
  }

  // LA REPETICIÓN, que es lo que arruinaba la transcripción en una reunión de
  // verdad: Meet reescribe la MISMA fila mientras hablás y corrige palabras ya
  // escritas. Cuando eso pasaba, se remandaba la fila entera y cada línea
  // nueva arrastraba todo lo anterior (se veían párrafos repetidos tres veces).
  {
    const antes = posted.length;
    await page.evaluate(async () => {
      const caps = document.getElementById("caps");
      const row = document.createElement("div");
      row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
      caps.appendChild(row);
      row.querySelector(".n").textContent = "Diego Ruiz";
      const t = row.querySelector(".t");
      const pasos = [
        "contame un poco como andas",
        "contame un poco cómo andás todo bien",           // Meet CORRIGE acentos
        "contame un poco cómo andás todo bien bueno a ver",
      ];
      for (const p of pasos) { t.textContent = p; await new Promise((r) => setTimeout(r, 700)); }
    });
    await page.waitForTimeout(3000);
    const nuevas = posted.slice(antes);
    const todo = nuevas.map((p) => p.text).join(" ");
    const vecesQueAparece = (todo.match(/contame un poco/gi) || []).length;
    check("una corrección de Meet NO hace que se remande todo lo dicho",
      vecesQueAparece === 1,
      `«contame un poco» aparece ${vecesQueAparece} vez/veces en: ${nuevas.map((p) => `"${p.text}"`).join(" + ")}`);
  }

  // EL OTRO camino de la repetición (pasó en una reunión real): una parte ya
  // se emitió, la persona SIGUE hablando (hay cola pendiente), y Meet corrige
  // una palabra de lo YA emitido. El motor viejo emitía primero la cola VIEJA
  // y después la corregida: la misma frase dos veces con una palabra
  // cambiada. Ahora la cola pendiente se emite UNA vez, ya corregida.
  {
    const antes = posted.length;
    await page.evaluate(async () => {
      const caps = document.getElementById("caps");
      const row = document.createElement("div");
      row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
      caps.appendChild(row);
      row.querySelector(".n").textContent = "Elsa Prieto";
      const t = row.querySelector(".t");
      t.textContent = "la campaña nueva arranca el lunes que viene.";
      await new Promise((r) => setTimeout(r, 2200)); // asentó: se emitió
      t.textContent = "la campaña nueva arranca el lunes que viene. después vemos los números del presupuesto";
      await new Promise((r) => setTimeout(r, 400)); // cola pendiente, sin asentar
      // Meet corrige "lunes" -> "martes" DENTRO de lo ya emitido, y la frase sigue
      t.textContent = "la campaña nueva arranca el martes que viene. después vemos los números del presupuesto con todo el equipo";
    });
    await page.waitForTimeout(3000);
    const nuevas = posted.slice(antes).filter((p) => p.speaker === "Elsa Prieto");
    const todo = nuevas.map((p) => p.text).join(" || ");
    const vecesPendiente = (todo.match(/después vemos los números/gi) || []).length;
    check("corregir una palabra YA emitida no duplica la cola pendiente",
      vecesPendiente === 1 && nuevas.length === 2,
      `la cola aparece ${vecesPendiente} vez/veces en ${nuevas.length} envíos: ${todo.slice(0, 150)}`);
  }

  // EL MONÓLOGO SIN PAUSAS. Si nadie respira 1,6 segundos, el asentamiento no
  // llega nunca: ni una línea salía al panel/historial hasta que la persona
  // terminara -- "se traba" mientras alguien habla de corrido. Ahora la parte
  // ya fría se emite por el camino, y el servidor pega los pedazos en una
  // línea. Acá: que salga POR PARTES y que no se pierda NI UNA palabra.
  {
    const antes = posted.length;
    const monologo =
      "el plan de este trimestre tiene tres partes bien claras que quiero repasar con calma " +
      "primero la campaña de lanzamiento que arranca en dos semanas con el equipo de contenido " +
      "después viene la parte de alianzas donde tenemos cuatro conversaciones abiertas con socios nuevos " +
      "y por último el presupuesto de herramientas que hay que cerrar antes de fin de mes sin falta";
    await page.evaluate(async (texto) => { await window.__say("Gustavo Peña", texto); }, monologo);
    await page.waitForTimeout(3000);
    const nuevas = posted.slice(antes).filter((p) => p.speaker === "Gustavo Peña");
    check("un monólogo largo se emite POR PARTES (no se traba hasta la pausa)",
      nuevas.length >= 2, `envíos=${nuevas.length}`);
    const junto = nuevas.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    check("y al partirlo no se pierde NI UNA palabra",
      junto === monologo, junto === monologo ? "texto completo" : `quedó: …${junto.slice(-80)}`);
  }

  // Y la red de seguridad: si Meet recicla su fila y reaparece texto viejo, no
  // se transcribe dos veces la misma frase.
  {
    const antes = posted.length;
    await page.evaluate(async () => {
      const caps = document.getElementById("caps");
      const row = document.createElement("div");
      row.innerHTML = '<img alt=""><div class="n"></div><div class="t"></div>';
      caps.appendChild(row);
      row.querySelector(".n").textContent = "Diego Ruiz";
      row.querySelector(".t").textContent =
        "contame un poco cómo andás todo bien bueno a ver. esto sí es nuevo del todo.";
    });
    await page.waitForTimeout(3000);
    const texto = posted.slice(antes).map((p) => p.text).join(" ");
    check("una frase que ya se dijo no vuelve a entrar en la transcripción",
      !/contame un poco/i.test(texto) && /esto sí es nuevo/i.test(texto),
      `"${texto}"`);
  }


  // ═══════ El enlace que te mandan por WhatsApp ═══════
  //
  // El caso de todos los días: te pasan un link de Meet, lo abrís y caés en
  // la SALA DE ESPERA ("Unirse ahora"), todavía afuera de la llamada. Ahí es
  // donde tiene que avisar -- no después, con la reunión ya empezada. Y lo
  // que se responde ahí tiene que valer del otro lado.
  console.log("\n── El enlace de WhatsApp: sala de espera → entrar ──");
  {
    // La página se sirve YA como sala de espera, que es como cae quien abre
    // el enlace: sin botón de colgar, con la vista previa de micrófono y
    // cámara, y "Unirse ahora". (Cargar una llamada y recortarla después no
    // sería el mismo caso: el aviso ya habría salido con el texto de adentro.)
    const SALA_DE_ESPERA = PAGE.replace(
      '<button aria-label="Salir de la llamada">Salir</button>',
      '<button id="entrar">Unirse ahora</button>'
    );
    await ctx.route("**/lmn-opqr-stu", (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: SALA_DE_ESPERA })
    );
    const p3 = await ctx.newPage();
    p3.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
    await p3.goto("http://localhost:4189/lmn-opqr-stu", { waitUntil: "domcontentloaded" });
    await p3.waitForTimeout(3000);

    check("al abrir el enlace, avisa YA en la sala de espera",
      (await p3.locator("#unify-aviso").count()) === 1);
    const t3 = await p3
      .locator("#unify-aviso")
      .evaluate((el) => el.shadowRoot?.querySelector(".caja")?.textContent?.trim() ?? "")
      .catch(() => "");
    check("y dice que te estás UNIENDO (no que ya estás adentro)",
      /te estás uniendo a una reunión de Google Meet/.test(t3), t3.slice(0, 70));
    check("sin montar el panel todavía (no hay nada que transcribir aún)",
      (await p3.locator("#unify-root").count()) === 0);

    // Dice que sí ANTES de entrar, y recién después entra a la llamada.
    await p3.evaluate(() =>
      document.getElementById("unify-aviso").shadowRoot.querySelector(".si").click()
    );
    await p3.evaluate(() => {
      document.getElementById("entrar")?.remove();
      const b = document.createElement("button");
      b.setAttribute("aria-label", "Salir de la llamada");
      document.body.appendChild(b);
    });
    await p3.waitForTimeout(3000);

    check("al entrar, el panel se abre solo con lo que ya había aceptado",
      await p3.evaluate(() =>
        Boolean(document.getElementById("unify-root")?.shadowRoot?.querySelector(".drawer.is-open"))
      ));
    check("y no le vuelve a preguntar lo mismo del otro lado",
      (await p3.locator("#unify-aviso").count()) === 0);
    await p3.close();
  }

  // ═══════ Meet en OTRO IDIOMA (o con otra redacción) ═══════
  //
  // La detección de "estoy dentro de la llamada" miraba el botón de colgar en
  // dos idiomas nada más. Si Meet decía "Sair da chamada" -- o "Salir de la
  // VIDEOllamada", que Google también usa -- la extensión no aparecía NUNCA y
  // sin un solo error en consola: el modo más cruel de fallar. Acá se sirve
  // un Meet en portugués para exigir que igual funcione.
  console.log("\n── Meet en otro idioma ──");
  {
    const p2 = await ctx.newPage();
    p2.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
    await ctx.route("**/idioma-portugues", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: PAGE.replace('aria-label="Salir de la llamada"', 'aria-label="Sair da chamada"'),
      })
    );
    await p2.goto("http://localhost:4189/xyz-abcd-efg?idioma=pt", { waitUntil: "domcontentloaded" });
    // Se reescribe la etiqueta EN LA PÁGINA, que es lo mismo que hace Meet al
    // renderizar en otro idioma.
    await p2.evaluate(() => {
      const b = document.querySelector('button[aria-label="Salir de la llamada"]');
      if (b) b.setAttribute("aria-label", "Sair da chamada");
    });
    await p2.waitForTimeout(3000);
    check("con Meet en portugués, la extensión igual aparece",
      (await p2.locator("#unify-root").count()) > 0);
    check("y también avisa", (await p2.locator("#unify-aviso").count()) === 1);
    await p2.close();
  }

  check("sin errores de JavaScript", errs.length === 0, errs[0] || "");

  await ctx.close();
  server.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
