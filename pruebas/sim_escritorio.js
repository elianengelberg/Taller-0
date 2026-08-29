// LA APP DE ESCRITORIO, lanzada de verdad.
//
// Se corre Electron con el main.js real contra la web local y se mira, desde
// adentro del proceso, qué ventana quedó. Nació de un problema concreto: la
// app se instalaba en Windows y no aparecía NADA (era sólo un ícono al lado
// del reloj que abría el navegador), así que se sentía una página web y no un
// programa. Estas comprobaciones son las que impiden que vuelva a pasar.
//
// Necesita la web servida en :4174 y las dependencias de desktop instaladas
// (cd desktop && npm install). Se corre con xvfb-run.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const DESK = "/home/user/Taller-0/desktop";

// ── 0. La extensión mantenida por la app (puro Node, sin ventanas) ─────────
// La Web Store se actualiza sola, pero el ZIP no: la app guarda la extensión
// en su carpeta de datos y la refresca contra la web. Acá se ejercita ese
// módulo REAL contra la web local: crear, decir "al día", y actualizar una
// versión vieja sin romper nada.
async function probarExtensionLocal(check) {
  const os = require("os");
  const { refrescarExtension, versionInstalada } = require(path.join(DESK, "extensionLocal.js"));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "unify-extloc-"));
  const WEB = "http://localhost:4174";
  const publicada = JSON.parse(fs.readFileSync("/home/user/Taller-0/client/dist/version-extension.json", "utf8")).version;

  const r1 = await refrescarExtension({ baseDir: base, web: WEB });
  check("la app instala la extensión desde cero (baja el zip y lo abre)",
    r1.estado === "creada" && r1.version === publicada,
    `estado=${r1.estado} v=${r1.version}`);
  check("y la carpeta queda lista para «Cargar descomprimida»",
    versionInstalada(path.join(base, "extension")) === publicada &&
    fs.existsSync(path.join(base, "extension", "content.js")));

  const r2 = await refrescarExtension({ baseDir: base, web: WEB });
  check("si ya está al día, no baja nada de nuevo", r2.estado === "al-dia", r2.estado);

  // Se simula una instalación VIEJA: el próximo refresco la tiene que subir.
  const manifest = path.join(base, "extension", "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  m.version = "1.0.0";
  fs.writeFileSync(manifest, JSON.stringify(m));
  const r3 = await refrescarExtension({ baseDir: base, web: WEB });
  check("una versión vieja se actualiza sola al refrescar",
    r3.estado === "actualizada" && versionInstalada(path.join(base, "extension")) === publicada,
    `estado=${r3.estado} v=${versionInstalada(path.join(base, "extension"))}`);

  // Y si la web no responde, la instalada NO se toca (vieja > rota).
  const r4 = await refrescarExtension({ baseDir: base, web: "http://localhost:4599" });
  check("sin red, la extensión instalada queda intacta (no se rompe nada)",
    r4.estado === "error" && versionInstalada(path.join(base, "extension")) === publicada,
    r4.estado);
  fs.rmSync(base, { recursive: true, force: true });
}

const sonda = path.join("/tmp", "sonda-escritorio.js");
fs.writeFileSync(sonda, `
  const { app } = require("electron");
  const original = require(${JSON.stringify(path.join(DESK, "main.js"))});
  setTimeout(() => {
    const { BrowserWindow } = require("electron");
    const vs = BrowserWindow.getAllWindows();
    const v = vs[0];
    const r = {
      ventanas: vs.length,
      visible: v ? v.isVisible() : false,
      titulo: v ? v.getTitle() : null,
      url: v ? v.webContents.getURL() : null,
      ancho: v ? v.getBounds().width : 0,
    };
    console.log("RESULTADO " + JSON.stringify(r));
    app.exit(0);
  }, 9000);
`);
const hijo = spawn(path.join(DESK, "node_modules/.bin/electron"), [sonda, "--no-sandbox"], {
  env: { ...process.env, UNIFY_WEB: "http://localhost:4174", DISPLAY: process.env.DISPLAY },
  stdio: ["ignore", "pipe", "pipe"],
});
let salida = "";
hijo.stdout.on("data", (d) => { salida += d; process.stdout.write(d); });
hijo.stderr.on("data", (d) => process.stderr.write(d));
hijo.on("exit", async (c) => {
  const m = salida.match(/RESULTADO (.+)/);
  if (!m) { console.log("FAIL sin resultado (código " + c + ")"); process.exit(1); }
  const r = JSON.parse(m[1]);
  const ok = [];
  const check = (n, c, d = "") => { ok.push(c); console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
  await probarExtensionLocal(check).catch((e) => check("módulo de extensión local", false, String(e.message)));
  check("la app de escritorio abre UNA ventana propia (antes no abría ninguna)", r.ventanas === 1, `ventanas=${r.ventanas}`);
  check("y se ve (no queda escondida en la bandeja)", r.visible === true);
  check("con el título de la app", r.titulo === "Unify", String(r.titulo));
  check("y arranca en la PANTALLA DE INICIO", /localhost:4174\/?$/.test(r.url || ""), String(r.url));
  check("con tamaño de app de verdad", r.ancho >= 1000, `${r.ancho}px`);
  console.log(`\n${ok.filter(Boolean).length}/${ok.length} OK`);
  process.exit(ok.every(Boolean) ? 0 : 1);
});
