// Live UI simulation of joining EXTERNAL meetings (Zoom/Meet/Teams/Jitsi):
// detection, routing to the right embed, companion socket connect, and
// graceful errors when a platform's server config is missing (no white screen).
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const BASE = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

async function detectAndJoin(page, link, { passcode } = {}) {
  await page.goto(`${BASE}/externa`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Enlace de la reunión").fill(link);
  await page.getByLabel("Tu nombre").fill("Tester");
  await page.getByRole("button", { name: /^Detectar$/ }).click();
  await page.waitForTimeout(400);
  if (passcode !== undefined) {
    const pc = page.getByLabel(/Contraseña de la reunión/i);
    if (await pc.count()) await pc.first().fill(passcode);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });

  // ---- Detection + routing (no external SDma load needed) ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

    // Un enlace de una plataforma que no conocemos por nombre ya NO es un
    // callejón sin salida: se ofrece acompañarlo con Unify al lado (subtítulos,
    // traducción, IA y grabación no dependen de la otra plataforma).
    await detectAndJoin(p, "https://example.com/foo");
    check("plataforma desconocida → se ofrece Unify al lado",
      (await p.getByText(/No conocemos/i).count()) > 0 &&
        (await p.getByRole("button", { name: /Unirme con Unify al lado/i }).count()) > 0);
    // Un enlace sin sala sigue sin ofrecerse: no identifica ninguna reunión.
    await detectAndJoin(p, "https://example.com/");
    check("enlace sin sala → sigue diciendo que no lo reconoce",
      (await p.getByText(/No reconocimos ese enlace/i).count()) > 0);

    // Zoom detection
    await detectAndJoin(p, "https://us05web.zoom.us/j/1234567890?pwd=abc");
    check("Zoom detectado con número", (await p.getByText(/Reconocimos una reunión de/i).count()) > 0 && (await p.getByText(/Zoom/).count()) > 0);
    check("Zoom: se muestra el número extraído del enlace", (await p.getByText(/1234567890/).count()) > 0);
    // Con credenciales ofrece unirse acá dentro (+ contraseña); sin ellas avisa y
    // ofrece abrirlo afuera. Las dos ramas son correctas: se valida la coherencia.
    {
      const joinable = (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) > 0;
      const pass = (await p.getByLabel(/Contraseña de la reunión/i).count()) > 0;
      const warned = (await p.getByText(/no tiene configuradas las credenciales/i).count()) > 0;
      const openOut = (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0;
      check("Zoom: la oferta es coherente con la config del servidor",
        (joinable && pass && !warned) || (!joinable && warned && openOut),
        `unirse=${joinable} pass=${pass} aviso=${warned} abrir=${openOut}`);
    }

    // Meet detection
    await detectAndJoin(p, "https://meet.google.com/abc-defg-hij");
    check("Meet detectado con código", (await p.getByText(/Google Meet/i).count()) > 0);
    check("Meet ofrece unirse (companion + extensión)", (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) > 0);

    // Teams detection
    await detectAndJoin(p, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0");

    // auto=1 (el botón «Abrir Unify al lado» de la extensión): DERECHO al
    // companion, sin formulario -- la persona ya está en la reunión y sólo
    // quiere Unify al lado, como en Meet.
    await p.goto(`${BASE}/externa?url=${encodeURIComponent("https://us05web.zoom.us/j/95556667770")}&auto=1`, { waitUntil: "domcontentloaded" });
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15_000 }).catch(() => {});
    check("con auto=1 se entra DERECHO al companion (cero formularios)",
      p.url().includes("/externa/reunion"), p.url());

    // LA OREJA GRANDE: donde la reunión vive AFUERA, el botón «Escuchar a
    // TODA la reunión» está a la vista y su clic pide la captura de pantalla
    // con audio (que es lo que mete las voces de todos al reconocimiento).
    {
      await p.addInitScript(() => {
        window.__gdmLlamadas = 0;
        if (navigator.mediaDevices) {
          navigator.mediaDevices.getDisplayMedia = () => {
            window.__gdmLlamadas += 1;
            return Promise.reject(new DOMException("cancelado", "NotAllowedError"));
          };
        }
      });
      await p.goto(`${BASE}/externa?url=${encodeURIComponent("https://meet.google.com/oye-todo-sxx")}&auto=1`, { waitUntil: "domcontentloaded" });
      await p.waitForURL(/\/externa\/reunion/, { timeout: 15_000 }).catch(() => {});
      const oreja = p.getByRole("button", { name: /Escuchar a TODA la reunión/i });
      check("el companion de una reunión de afuera ofrece «Escuchar a TODA la reunión»",
        (await oreja.count()) === 1);
      await oreja.first().click();
      await p.waitForTimeout(1200);
      check("y el clic pide la captura de pantalla con audio (getDisplayMedia)",
        await p.evaluate(() => window.__gdmLlamadas >= 1),
        `llamadas=${await p.evaluate(() => window.__gdmLlamadas)}`);
      // SÓLO TU VOZ, dicho donde se mira (reporte real: en la compu la
      // persona hablaba, veía lo suyo, y de los demás nada, sin saber por
      // qué). Mientras no llegue una voz ajena, el aviso queda con la oreja y
      // el camino de la extensión; apenas llega una (extensión/bot), se va.
      const aviso = p.getByRole("note", { name: /sólo se oye tu voz/i });
      check("mientras sólo se oye tu voz, el escenario lo dice con la salida de la compu (compartir con audio, o la extensión en Meet)",
        (await aviso.count()) === 1 && /Compartir audio del sistema/.test((await aviso.textContent().catch(() => "")) || "") && /extensión de Unify/.test((await aviso.textContent().catch(() => "")) || ""),
        ((await aviso.textContent().catch(() => "")) || "").slice(0, 100));
      await fetch(`http://localhost:4001/api/meet-bridge/${encodeURIComponent("google-meet:oye-todo-sxx")}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker: "Bruno", text: "hola desde la reunión de afuera, ¿se escucha?", lang: "es-AR" }),
      }).catch(() => {});
      let seFue = false;
      for (let i = 0; i < 25 && !seFue; i++) {
        await p.waitForTimeout(400);
        seFue = (await aviso.count()) === 0 && (await p.getByText(/se escucha\?/).count()) >= 1;
      }
      check("apenas llega la voz de otra persona, el aviso se va y la frase aparece con su nombre", seFue && (await p.getByText("Bruno").count()) >= 1,
        `aviso=${await aviso.count()} frase=${await p.getByText(/se escucha\?/).count()}`);
    }
    // Volver a la detección de Teams para los checks que siguen.
    await detectAndJoin(p, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0");
    check("Teams detectado", (await p.getByText(/Microsoft Teams/i).count()) > 0);

    // Jitsi detection
    await detectAndJoin(p, "https://meet.jit.si/UnifyTestRoom123");
    check("Jitsi detectado con sala", (await p.getByText(/Jitsi Meet/i).count()) > 0);

    // Zoom personal/vanity link (no number) → honest "can't join, open in Zoom"
    await detectAndJoin(p, "https://zoom.us/my/somename");
    check("Zoom sin número → no ofrece unirse acá, ofrece abrir en Zoom", (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0);

    check("sin errores de página en toda la detección", errs.length === 0, errs[0] || "");
    await p.close();
  }

  // ---- "Unirme" abre la reunión REAL (el bug del celular: pegabas el link
  //      de Meet y Unify te dejaba en su capa sin llevarte nunca a la
  //      reunión). El clic tiene que abrir Meet en su pestaña/app Y dejar la
  //      capa de Unify con un botón grande para volver a abrirla. ----
  {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__abiertos = [];
      window.open = (url) => {
        window.__abiertos.push(String(url));
        return null;
      };
    });
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.google.com/abc-defg-hij");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    const abiertos = await p.evaluate(() => window.__abiertos);
    check("el clic de «Unirme» ABRE la reunión real de Meet (pestaña/app)",
      abiertos.some((u) => u.includes("meet.google.com/abc-defg-hij")), JSON.stringify(abiertos));
    check("y la capa Unify deja un botón GRANDE para volver a abrirla",
      (await p.getByRole("link", { name: /Abrir la reunión de Meet/i }).count()) > 0);
    // EL BOTÓN RESPONDE EN TODA SU SUPERFICIE. La barra de Unify (traducir,
    // flotantes, texto grande) flotaba ENCIMA con position absolute: en el
    // iPad se estiraba, tapaba la cabecera de la reunión y se comía los toques
    // en media superficie del botón -- «no funciona todo el botón, hay que
    // tocar un botón en específico» (reporte real). Se prueba tocando de
    // verdad: en cinco puntos a lo ancho, quien recibe el toque tiene que ser
    // el botón.
    {
      const tapado = await p.evaluate(() => {
        const a = [...document.querySelectorAll("a")].find((x) =>
          /Abrir la reunión de Meet/.test(x.textContent || ""),
        );
        if (!a) return { hay: false };
        const r = a.getBoundingClientRect();
        const encima = [];
        for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const el = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
          if (!el || !(el === a || a.contains(el))) {
            encima.push(`${Math.round(f * 100)}%: ${el ? el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 24) : "nada"}`);
          }
        }
        return { hay: true, encima };
      });
      check("el botón de entrar a la reunión recibe el toque en TODA su superficie",
        tapado.hay && tapado.encima.length === 0,
        tapado.hay ? tapado.encima.join(" | ") || "libre" : "no se encontró el botón");
    }
    // Y LA CABECERA DE LA REUNIÓN NO QUEDA DEBAJO DE LA BARRA: el código de la
    // sala tiene que verse, no asomar por detrás («hay un label encima de otro»).
    {
      const codigoTapado = await p.evaluate(() => {
        // El código vive en la cabecera, dentro del nombre de la sala
        // («Google Meet · abc-defg-hij»): se busca el elemento MÁS CHICO que
        // lo contenga, que es el que se ve.
        const todos = [...document.querySelectorAll("span, p")].filter((x) =>
          /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/.test((x.textContent || "").trim()),
        );
        const el = todos.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
        if (!el) return { hay: false };
        const r = el.getBoundingClientRect();
        const arriba = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { hay: true, propio: Boolean(arriba && (arriba === el || el.contains(arriba) || arriba.contains(el))) };
      });
      check("el código de la reunión se ve entero, sin la barra de Unify encima",
        codigoTapado.hay && codigoTapado.propio, JSON.stringify(codigoTapado));
    }
    // AL ACHICAR LA PANTALLA, LOS SUBTÍTULOS SON LO PRINCIPAL. En Split View
    // (o una ventana angosta al lado de Meet) la cabecera, el botón grande y
    // los consejos empujaban lo que se está diciendo fuera de la vista.
    {
      const codigoChico = "abc-defg-hij";
      const frase = "esto se tiene que leer aunque la ventana sea chica";
      await fetch(`http://localhost:4001/api/meet-bridge/${encodeURIComponent(`google-meet:${codigoChico}`)}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker: "Bruno", text: frase, lang: "es-AR" }),
      }).catch(() => {});
      await p.waitForTimeout(1200);
      const texto = p.getByText(frase);
      // Ventana chica: lo que se dijo tiene que estar A LA VISTA, sin scroll.
      await p.setViewportSize({ width: 420, height: 560 });
      await p.waitForTimeout(700);
      const caja = await texto.first().boundingBox().catch(() => null);
      const alto = await p.evaluate(() => window.innerHeight);
      check("con la ventana achicada, lo que se está diciendo se ve sin bajar la pantalla",
        Boolean(caja) && caja.y >= 0 && caja.y + caja.height <= alto,
        caja ? `y=${Math.round(caja.y)} alto=${Math.round(caja.height)} ventana=${alto}` : "no se encontró la frase");
      check("y el botón grande de abrir Meet se corre (el espacio es para el texto)",
        (await p.getByRole("link", { name: /Abrir la reunión de Meet/i }).count()) === 0);
      const tam = caja ? await texto.first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize)) : 0;
      check("con la letra más grande que en la pantalla completa", tam >= 24, `${tam}px`);
      // Y al agrandar de nuevo, todo vuelve.
      await p.setViewportSize({ width: 1200, height: 800 });
      await p.waitForTimeout(700);
      check("al agrandarla, la pantalla vuelve a estar completa",
        (await p.getByRole("link", { name: /Abrir la reunión de Meet/i }).count()) > 0);
    }
    await p.close();
  }
  {
    // Una embebible (Jitsi) corre ADENTRO: abrir otra copia afuera sería
    // duplicar la reunión.
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__abiertos = [];
      window.open = (url) => {
        window.__abiertos.push(String(url));
        return null;
      };
    });
    await p.route((url) => url.hostname.endsWith("jit.si"), (r) => r.abort());
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.jit.si/SalaAbrirReal1");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForTimeout(1500);
    check("una plataforma embebible (Jitsi) NO abre pestañas de más",
      (await p.evaluate(() => window.__abiertos)).length === 0);
    await p.close();
  }

  // ---- La pestaña que la APP dejó en blanco se cierra sola al volver ----
  // En iPad/celular la app de Meet se lleva el enlace y la pestaña recién
  // abierta queda huérfana en about:blank, al frente: quien volvía a Unify
  // aterrizaba en una página vacía. El companion la cierra al detectar el
  // regreso -- y JAMÁS toca una pestaña que sí navegó a la reunión (es de
  // otro origen y su location ni se puede leer).
  {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__abiertos = [];
      window.open = (url) => {
        window.__abiertos.push(String(url));
        const falsa = {
          closed: false,
          opener: {},
          document: {
            visibilityState: "visible",
            addEventListener: () => { falsa.__armada = true; },
          },
          close() { this.closed = true; },
        };
        Object.defineProperty(falsa, "location", {
          get() {
            if (window.__yaNavego) throw new Error("cross-origin");
            return { href: "about:blank" };
          },
        });
        window.__falsa = falsa;
        return falsa;
      };
    });
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.google.com/abc-defg-hij");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    check("al abrir la reunión se corta su acceso de vuelta (opener null)",
      await p.evaluate(() => Boolean(window.__falsa) && window.__falsa.opener === null));
    check("y el auto-cierre queda armado dentro de la pestaña",
      await p.evaluate(() => window.__falsa?.__armada === true));
    // La gracia de 3s: cerrar antes sería matar una reunión todavía cargando.
    await p.waitForTimeout(3300);
    await p.evaluate(() => { window.__yaNavego = true; document.dispatchEvent(new Event("visibilitychange")); });
    check("una pestaña que SÍ navegó a la reunión no se toca",
      await p.evaluate(() => window.__falsa.closed === false));
    await p.evaluate(() => { window.__yaNavego = false; document.dispatchEvent(new Event("visibilitychange")); });
    check("la que quedó en blanco se cierra sola al volver a Unify",
      await p.evaluate(() => window.__falsa.closed === true));
    await p.close();
  }

  // ---- El cartel de autorización en la COMPU: se pide al entrar ----
  // Al montar el companion con el permiso sin decidir, Unify pide micrófono
  // y cámara JUNTOS (un solo cartel nativo del navegador), sin esperar a que
  // nadie vaya a Configuración. Acá se espía getUserMedia para confirmar que
  // el pedido sale solo, y con ambos medios.
  {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      // El Chromium headless del arnés no trae reconocimiento de voz, y sin
      // él la app (con razón) no pide el micrófono. Un Chrome real lo trae:
      // este stub deja la condición como en la compu de verdad.
      window.webkitSpeechRecognition = class {
        start() {}
        stop() {}
        abort() {}
      };
      // El flag fake-ui del arnés deja el permiso "granted" de entrada y la
      // app (bien) no pediría nada. En una compu real el estado es "prompt":
      // se fuerza esa respuesta para probar el camino del cartel.
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) =>
        d && d.name === "microphone"
          ? Promise.resolve({ state: "prompt", onchange: null })
          : q(d);
      window.__gumPedidos = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => {
        window.__gumPedidos.push(c ? JSON.stringify(c) : "{}");
        return original(c);
      };
      window.open = () => null;
    });
    await p.route("**fonts.g**", (r) => r.abort());
    await detectAndJoin(p, "https://meet.google.com/car-telp-cpc");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(2500);
    const pedidos = await p.evaluate(() => window.__gumPedidos);
    // ABRIR LA PANTALLA NO PIDE EL MICRÓFONO. Antes sí, y en el iPad eso es un
    // cartel del sistema CADA VEZ que se entra («cada vez que abro la pantalla
    // me tira si autorizo el micrófono») -- para una escucha que además se
    // corta apenas la app pasa a segundo plano. Ahora la pantalla ofrece
    // primero la escucha que NO depende de este aparato, y el micrófono se
    // pide sólo cuando la persona lo pide.
    check("al entrar, la pantalla NO dispara el cartel de permisos por su cuenta",
      pedidos.length === 0, JSON.stringify(pedidos).slice(0, 120));
    const botonMic = p.getByRole("button", { name: /Usar el micrófono de este aparato/i });
    check("y ofrece prender el micrófono con un botón, dicho con todas las letras",
      (await botonMic.count()) === 1);
    await botonMic.first().click();
    await p.waitForTimeout(1200);
    const trasTocar = await p.evaluate(() => window.__gumPedidos);
    check("recién ahí se pide el permiso, y pide micrófono Y cámara juntos (un solo cartel)",
      trasTocar.some((c) => {
        try { const o = JSON.parse(c); return o.audio === true && o.video === true; } catch { return false; }
      }), JSON.stringify(trasTocar).slice(0, 120));
    await p.close();
  }

  // ---- Graceful errors joining unconfigured platforms (Zoom/Teams 503) ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));

    // Zoom sin credenciales: desde el cambio de "aviso previo", ya NO se ofrece
    // unirse acá dentro -- se avisa antes y se ofrece abrirlo en Zoom.
    await detectAndJoin(p, "https://us05web.zoom.us/j/1234567890", { passcode: "" });
    await p.waitForTimeout(800);
    check("Zoom sin config: avisa antes y NO ofrece unirse acá dentro",
      (await p.getByRole("button", { name: /Unirme acá dentro/i }).count()) === 0 &&
      (await p.getByText(/no tiene configuradas las credenciales/i).count()) > 0);
    check("Zoom sin config: ofrece abrirlo en su plataforma",
      (await p.getByRole("link", { name: /Abrir en Zoom/i }).count()) > 0);
    check("Zoom: la página no crashea", errs.length === 0, errs[0] || "");
    await p.close();
  }

  // ---- Jitsi companion connects (Unify layer) even if external script blocked ----
  {
    const p = await ctx.newPage();
    await p.route("**fonts.g**", (r) => r.abort());
    // Block the external Jitsi script to simulate it being unavailable; the
    // Unify companion layer must still connect and the page must not crash.
    await p.route("**external_api.js", (r) => r.abort());
    const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
    await detectAndJoin(p, "https://meet.jit.si/UnifyRoomXYZ");
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForTimeout(2500);
    check("Jitsi: la capa Unify conecta (companion)", (await p.getByTitle(/Invitar a los demás/i).count()) > 0);
    check("Jitsi con script bloqueado: no crashea, muestra algo", errs.length === 0, errs[0] || "");
    // Regla de la casa: DENTRO de la reunión también tiene que haber un
    // Volver a la vista en el encabezado (el Salir del dock no alcanza).
    // La regla es que haya una SALIDA a la vista en el encabezado. Ahora se
    // llama «Salir» (con su ícono), que es lo que hace: sale de Unify y la
    // reunión sigue en su app.
    check("Jitsi adentro: hay una salida a la vista en el encabezado",
      (await p.getByRole("button", { name: /Volver|Salir/i }).count()) > 0);
    await p.close();
  }

  // ---- Regla de la casa: TODA pantalla tiene un "Volver" a la vista --------
  // (Salvo el inicio, que es la raíz.) Esto existe porque ya pasó dos veces
  // que una pantalla quedaba sin salida; acá se recorren todas las rutas.
  {
    const rutas = [
      "/instalar", "/privacidad", "/soporte", "/ingresar", "/registrarse",
      "/verificar-email", "/recuperar", "/restablecer", "/crear", "/unirse",
      "/externa",
    ];
    const p = await ctx.newPage();
    for (const ruta of rutas) {
      await p.goto(`${BASE}${ruta}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(600);
      const visible = await p.getByText(/volver/i).count();
      check(`hay un Volver a la vista en ${ruta}`, visible > 0, `coincidencias=${visible}`);
    }
    await p.close();
  }

  // ---- TEXTO GRANDE: un interruptor que agranda toda la app y se recuerda --
  // Para quien ve chico (abuelos, sin anteojos a mano): un toque, en todas
  // las pantallas, sin tocar el sistema ni el zoom del navegador.
  {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(500);
    const tam = () => p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const base = await tam();
    const boton = p.getByRole("button", { name: /Texto grande/i }).first();
    check("en el inicio hay un botón «Texto grande»", (await boton.count()) > 0);
    await boton.click();
    await p.waitForTimeout(300);
    const grande = await tam();
    check("tocarlo agranda la letra de toda la app", grande > base * 1.1, `${base}px -> ${grande}px`);
    check("y el botón pasa a decir «Texto normal»",
      (await p.getByRole("button", { name: /Texto normal/i }).count()) > 0);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(500);
    const trasRecargar = await tam();
    check("se recuerda al recargar", trasRecargar > base * 1.1, `${trasRecargar}px`);
    await p.getByRole("button", { name: /Texto normal/i }).first().click();
    await p.waitForTimeout(300);
    check("y se vuelve al tamaño normal", Math.abs((await tam()) - base) < 0.5, `${await tam()}px`);
    await p.close();
  }

  // ---- El idioma de LOS DEMÁS: selector con nombres enteros y cambio solo ----
  // El oído de "la reunión" escuchaba en TU idioma; te hablaban en inglés y
  // salían palabras inventadas, etiquetadas "es-AR" y sin traducir. Ahora
  // tiene su selector («Se habla»), en Automático cambia solo cuando dos
  // frases seguidas de los demás llegan en otro idioma, y la línea en inglés
  // se pide traducir DESDE inglés.
  {
    const letras = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    const codigo = `${letras(3)}-${letras(4)}-${letras(3)}`;
    const p = await ctx.newPage();
    const pedidos = [];
    p.on("request", (r) => { if (r.url().includes("/api/translate")) { try { pedidos.push(JSON.parse(r.postData() || "{}")); } catch {} } });
    // El Chromium del arnés está en inglés: la persona de esta prueba habla
    // español (es lo que recuerda la app como "tu idioma").
    await p.addInitScript(() => { window.open = () => null; localStorage.setItem("unify_lang", "es-AR"); });
    await detectAndJoin(p, `https://meet.google.com/${codigo}`);
    await p.getByRole("button", { name: /Unirme acá dentro/i }).click();
    await p.waitForURL(/\/externa\/reunion/, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(2500);
    const seHabla = p.getByLabel("Idioma en el que hablan los demás");
    check("el dock tiene el selector «Se habla» (el idioma de los demás)", (await seHabla.count()) === 1);
    const opciones = await seHabla.locator("option").allTextContents().catch(() => []);
    check("con los idiomas con nombre entero, sin siglas",
      opciones.includes("Español (Argentina)") && opciones.includes("Inglés (EE. UU.)") && !opciones.some((o) => /^[A-Z]{2}(-[A-Z]{2})?$/.test(o.trim())),
      opciones.slice(0, 4).join(" | "));
    check("y arranca en Automático con tu idioma", /^Automático \(Español/.test(opciones[0] || ""), opciones[0]);
    const traducirA = await p.getByLabel("Traducir los subtítulos a").locator("option").allTextContents().catch(() => []);
    check("«Traducir a» también muestra los nombres enteros", traducirA.includes("Inglés (EE. UU.)") && traducirA.includes("Portugués (Brasil)"));
    // Dos frases de otra persona en inglés, etiquetadas en español (así las
    // manda un reconocedor configurado en español).
    for (const text of ["we need to close the budget before friday and I think the numbers are fine", "okay so let's move to the next item on the agenda and talk about the timeline"]) {
      await fetch(`http://localhost:4001/api/meet-bridge/${encodeURIComponent(`google-meet:${codigo}`)}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker: "Ellen", text, lang: "es-AR" }),
      });
      await p.waitForTimeout(700);
    }
    await p.waitForTimeout(2500);
    const opcionesDespues = await seHabla.locator("option").allTextContents().catch(() => []);
    check("al llegar dos frases en inglés, «Se habla» pasa solo a inglés",
      /^Automático \(Inglés/.test(opcionesDespues[0] || ""), opcionesDespues[0]);
    const cuerpo = (await p.locator("body").textContent()) || "";
    check("y avisa por qué cambió", /Los demás hablan en Inglés/.test(cuerpo), cuerpo.slice(0, 100).replace(/\s+/g, " "));
    // EL ESCENARIO NO SE TAPA: en Meet/externa la frase vive UNA vez (en el
    // escenario grande). Antes las burbujas flotantes la repetían encima y
    // cubrían las últimas líneas del escenario.
    const vecesEnPantalla = await p.evaluate(() => {
      // Se cuentan NODOS DE TEXTO (la burbuja mete la frase como texto suelto
      // al lado del avatar y del nombre; mirar sólo elementos sin hijos la
      // dejaba pasar).
      const objetivo = "close the budget before friday";
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = 0;
      while (w.nextNode()) if ((w.currentNode.nodeValue || "").includes(objetivo)) n++;
      return n;
    });
    check("la frase se muestra UNA sola vez (el escenario, sin burbujas encima)", vecesEnPantalla === 1, `veces=${vecesEnPantalla}`);
    check("la frase en inglés etiquetada como español se pide traducir DESDE inglés",
      pedidos.some((q) => /close the budget/.test(q.text || "") && String(q.source || "").startsWith("en") && String(q.target || "").startsWith("es")),
      JSON.stringify(pedidos.map((q) => [q.source, q.target]).slice(0, 4)));
    // Elegir a mano manda: queda guardado y ya no cambia solo.
    await seHabla.selectOption("pt-BR");
    await p.waitForTimeout(400);
    check("elegir un idioma a mano se recuerda",
      (await p.evaluate(() => localStorage.getItem("unify_lang_reunion"))) === "pt-BR");
    await p.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SIM ERROR:", e.message, e.stack); process.exit(1); });
