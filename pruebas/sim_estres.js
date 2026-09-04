// Estrés de la interfaz durante una reunión: compartir pantalla cruzado con
// otras acciones, y clics rápidos en todo lo que se puede tocar.
//
// El foco está en lo que rompe de verdad: que una acción cualquiera dentro de
// la web (apagar la cámara, cambiar de dispositivo, abrir paneles) deje la
// reunión en un estado inconsistente.
const { chromium } = require("/opt/node22/lib/node_modules/playwright/node_modules/playwright-core");
const B = "http://localhost:4174";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
// Un elemento que TIENE que estar: si no está, es FAIL (no un salto en
// silencio que deja la suite en verde con la pantalla rota).
const exigir = async (loc, nombre) => {
  const n = await loc.count().catch(() => 0);
  if (n > 0) return true;
  check(nombre, false, "no está en la pantalla");
  return false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const IGNORABLE = /fonts\.g|external_api|favicon|ERR_ABORTED|jit\.si|zoom|teams|whereby|element\.io|8x8|ResizeObserver|Download the React|api\/(zoom\/signature|teams\/token)/i;
function watch(page, bag) {
  page.on("pageerror", (e) => bag.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Recurso externo cortado por el sandbox (proxy 502/404): no es del producto.
    if (/Failed to load resource/i.test(m.text()) && !(m.location?.().url || "").includes("localhost")) return;
    const t = `${m.text()} ${m.location?.().url || ""}`;
    if (!IGNORABLE.test(t)) bag.push(`consola: ${m.text().slice(0, 110)}`);
  });
}

// Estado real de las pistas de video del stream local, leído del <video> propio.
async function videoTracks(page) {
  return page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll("video"));
    for (const v of vids) {
      const s = v.srcObject;
      if (s && typeof s.getVideoTracks === "function" && s.getVideoTracks().length) {
        return s.getVideoTracks().map((t) => ({
          label: t.label,
          enabled: t.enabled,
          state: t.readyState,
          // Las pistas de pantalla exponen displaySurface; las de cámara no.
          screen: Boolean(t.getSettings().displaySurface),
        }));
      }
    }
    return [];
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--auto-accept-this-tab-capture",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["microphone", "camera"],
  });
  await ctx.route("**fonts.g**", (r) => r.abort());
  await ctx.route("**external_api.js", (r) => r.abort());
  await ctx.addInitScript(() => {
    try { localStorage.setItem("unify_autorecord_externa", "0"); } catch {}
  });

  // ═══════ 1. Compartir pantalla cruzado con otras acciones ═══════
  console.log("\n── 1. Compartir pantalla + acciones ──");
  {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await p.goto(`${B}/crear`, { waitUntil: "domcontentloaded" });
    await p.getByLabel(/Tu nombre/i).fill("Anfitrión");
    await p.getByRole("button", { name: /Crear|Empezar|Iniciar/i }).last().click();
    await p.waitForTimeout(4000);
    check("se entra a una reunión nativa", p.url().includes("/reunion"), p.url());

    const before = await videoTracks(p);
    check("hay cámara antes de compartir", before.some((t) => !t.screen && t.state === "live"),
      JSON.stringify(before).slice(0, 90));

    // Compartir pantalla
    const shareBtn = p.getByRole("button", { name: /Compartir (la )?pantalla|Compartir/i }).first();
    check("existe el botón de compartir pantalla", (await shareBtn.count()) > 0);
    await shareBtn.click();
    await p.waitForTimeout(2500);
    const shared = await videoTracks(p);
    const isSharing = shared.some((t) => t.screen && t.state === "live");
    check("al compartir, la pantalla entra al stream", isSharing, JSON.stringify(shared).slice(0, 110));

    if (isSharing) {
      // EL BUG: apagar la cámara mientras compartís apagaba la PANTALLA.
      const camBtn = p.getByRole("button", { name: /Apagar cámara/i }).first();
      if (await exigir(camBtn, "hay botón «Apagar cámara»")) { await camBtn.click(); await p.waitForTimeout(1200); }
      const afterCamOff = await videoTracks(p);
      const screenTrack = afterCamOff.find((t) => t.screen);
      check("apagar la cámara NO apaga la pantalla compartida",
        Boolean(screenTrack) && screenTrack.enabled === true && screenTrack.state === "live",
        JSON.stringify(afterCamOff).slice(0, 110));
      check("sigue compartiendo después de apagar la cámara",
        (await p.getByRole("button", { name: /Dejar de compartir|Compartiendo/i }).count()) > 0);

      // Volver a prender la cámara no debe romper nada.
      const camOn = p.getByRole("button", { name: /Activar cámara/i }).first();
      if (await exigir(camOn, "hay botón «Activar cámara»")) { await camOn.click(); await p.waitForTimeout(1000); }
      const afterCamOn = await videoTracks(p);
      check("prender la cámara tampoco pisa la pantalla",
        afterCamOn.some((t) => t.screen && t.state === "live"),
        JSON.stringify(afterCamOn).slice(0, 110));

      // EL OTRO BUG: cambiar de cámara mataba la pantalla y dejaba el estado
      // colgado en "compartiendo" para siempre.
      let switched = false;
      const settings = p.getByRole("button", { name: /Opciones: elegir micrófono/i }).first();
      if (await exigir(settings, "hay botón de Opciones (micrófono, cámara y parlante)")) {
        await settings.click();
        await p.waitForTimeout(700);
        const camSelect = p.getByLabel(/^Cámara$/).first();
        if (await exigir(camSelect, "el panel de opciones tiene el selector de cámara")) {
          const opts = await camSelect.locator("option").count();
          if (opts > 1) {
            await camSelect.selectOption({ index: 1 });
            await p.waitForTimeout(1500);
            switched = true;
          }
        }
        await p.keyboard.press("Escape");
        await p.waitForTimeout(500);
      }
      const afterSwitch = await videoTracks(p);
      // Sin una SEGUNDA cámara no hay cambio que hacer, y afirmar que "no se
      // rompió" sería una prueba vacía. Se dice cuál de los dos casos corrió.
      if (switched) {
        check("cambiar de cámara NO mata la pantalla compartida",
          afterSwitch.some((t) => t.screen && t.state === "live"),
          JSON.stringify(afterSwitch).slice(0, 110));
      } else {
        console.log("SKIP cambiar de cámara — este entorno expone una sola cámara falsa");
      }

      // Dejar de compartir devuelve la cámara.
      const stopBtn = p.getByRole("button", { name: /Dejar de compartir|Compartiendo/i }).first();
      if (await exigir(stopBtn, "hay botón «Dejar de compartir»")) { await stopBtn.click(); await p.waitForTimeout(1800); }
      const afterStop = await videoTracks(p);
      check("al dejar de compartir vuelve la cámara",
        afterStop.some((t) => !t.screen && t.state === "live") && !afterStop.some((t) => t.screen),
        JSON.stringify(afterStop).slice(0, 110));
      check("se puede volver a compartir después",
        (await p.getByRole("button", { name: /Compartir/i }).count()) > 0);
    }
    check("compartir pantalla sin errores de JS", bag.length === 0, bag.slice(0, 2).join(" | "));
    await p.close();
  }

  // ═══════ 2. Clics rápidos en la reunión nativa ═══════
  console.log("\n── 2. Clics rápidos (reunión nativa) ──");
  {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await p.goto(`${B}/crear`, { waitUntil: "domcontentloaded" });
    await p.getByLabel(/Tu nombre/i).fill("Rápido");
    await p.getByRole("button", { name: /Crear|Empezar|Iniciar/i }).last().click();
    await p.waitForTimeout(4000);

    // Todo lo que se puede tocar, dos vueltas, sin esperar entre clics.
    const labels = [
      /Silenciar micrófono|Activar micrófono/i,
      /Apagar cámara|Activar cámara/i,
      /Participantes/i,
      /Chat/i,
      /transcripción/i,
      /asistente de IA|IA/i,
      /Ajustes|Configuración/i,
      /subtítulos/i,
      /Levantar la mano|Bajar la mano/i,
    ];
    for (let round = 0; round < 2; round++) {
      for (const l of labels) {
        const b = p.getByRole("button", { name: l }).first();
        if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); }
      }
    }
    await p.waitForTimeout(2000);
    check("la reunión sigue en pie tras 18 clics seguidos",
      p.url().includes("/reunion") && (await p.getByRole("button", { name: /Salir/i }).count()) > 0);
    const tracks = await videoTracks(p);
    check("las pistas de media siguen sanas", tracks.every((t) => t.state === "live"),
      JSON.stringify(tracks).slice(0, 100));
    check("clics rápidos sin errores de JS", bag.length === 0, bag.slice(0, 2).join(" | "));
    await p.close();
  }

  // ═══════ 3. Clics rápidos en reuniones externas, plataforma por plataforma ═══════
  console.log("\n── 3. Clics rápidos (reuniones externas) ──");
  for (const [label, link] of [
    ["Google Meet", `https://meet.google.com/${rnd(3)}-${rnd(4)}-${rnd(3)}`],
    ["Zoom", "https://us05web.zoom.us/j/89123456789"],
    ["Jitsi", `https://meet.jit.si/Sala${rnd(6)}`],
    ["Teams personal", `https://teams.live.com/meet/${Math.floor(Math.random() * 1e13)}`],
    ["Whereby", `https://acme.whereby.com/sala${rnd(5)}`],
    ["GoTo", `https://global.gotomeeting.com/join/${Math.floor(Math.random() * 1e9)}`],
  ]) {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill(link);
    await p.getByLabel("Tu nombre").fill("Tester");
    await p.waitForTimeout(500);
    const btn = p.getByRole("button", { name: /Unirme/i }).first();
    if ((await btn.count()) === 0) { check(`${label}: ofrece unirse`, false); await p.close(); continue; }
    await btn.click();
    await p.waitForTimeout(3000);
    check(`${label}: entra`, p.url().includes("/externa/reunion"), p.url());

    // Toda la barra, dos vueltas, sin respirar.
    for (let round = 0; round < 2; round++) {
      for (const l of [/subtítulos/i, /transcripción/i, /roles/i, /asistente de IA/i, /Grabar/i]) {
        const b = p.getByRole("button", { name: l }).first();
        if (await b.count()) await b.click({ timeout: 3000 }).catch(() => {});
      }
      // Selector de idioma y la invitación, que abren capas encima.
      const lang = p.getByTitle(/Idioma en el que ves los subtítulos/i);
      if (await lang.count()) await lang.selectOption(round === 0 ? "en-US" : "es-AR").catch(() => {});
      const inv = p.getByTitle(/Invitar a los demás/i);
      if (await inv.count()) { await inv.click().catch(() => {}); await inv.click().catch(() => {}); }
    }
    await p.waitForTimeout(2000);
    check(`${label}: sigue en la reunión tras los clics`, p.url().includes("/externa/reunion"));
    check(`${label}: el dock sigue vivo`, (await p.getByTitle(/Invitar a los demás/i).count()) > 0);
    check(`${label}: sin errores de JS`, bag.length === 0, bag.slice(0, 2).join(" | "));
    // Si quedó grabando, se detiene para no dejar la captura viva.
    const rec = p.getByRole("button", { name: /Detener grabación/i }).first();
    if (await rec.count()) { await rec.click().catch(() => {}); await p.waitForTimeout(1500); }
    await p.close();
  }

  // ═══════ 4. Salir a la fuerza en medio de todo ═══════
  console.log("\n── 4. Salidas bruscas ──");
  {
    const p = await ctx.newPage();
    const bag = []; watch(p, bag);
    await p.goto(`${B}/externa`, { waitUntil: "domcontentloaded" });
    await p.getByLabel("Enlace de la reunión").fill(`https://meet.google.com/${rnd(3)}-${rnd(4)}-${rnd(3)}`);
    await p.getByLabel("Tu nombre").fill("Apurado");
    await p.waitForTimeout(500);
    await p.getByRole("button", { name: /Unirme/i }).first().click();
    await p.waitForTimeout(2800);
    // Abrir tres paneles y navegar hacia atrás de golpe.
    for (const l of [/transcripción/i, /roles/i, /asistente de IA/i]) {
      const b = p.getByRole("button", { name: l }).first();
      if (await b.count()) await b.click().catch(() => {});
    }
    await p.goBack().catch(() => {});
    await p.waitForTimeout(2000);
    check("volver atrás con paneles abiertos no rompe la app",
      !p.isClosed() && (await p.locator("body").textContent()) !== "", p.url());
    check("salida brusca sin errores de JS", bag.length === 0, bag.slice(0, 2).join(" | "));
    await p.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
