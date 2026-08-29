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
hijo.on("exit", (c) => {
  const m = salida.match(/RESULTADO (.+)/);
  if (!m) { console.log("FAIL sin resultado (código " + c + ")"); process.exit(1); }
  const r = JSON.parse(m[1]);
  const ok = [];
  const check = (n, c, d = "") => { ok.push(c); console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
  check("la app de escritorio abre UNA ventana propia (antes no abría ninguna)", r.ventanas === 1, `ventanas=${r.ventanas}`);
  check("y se ve (no queda escondida en la bandeja)", r.visible === true);
  check("con el título de la app", r.titulo === "Unify", String(r.titulo));
  check("y arranca en la PANTALLA DE INICIO", /localhost:4174\/?$/.test(r.url || ""), String(r.url));
  check("con tamaño de app de verdad", r.ancho >= 1000, `${r.ancho}px`);
  process.exit(ok.every(Boolean) ? 0 : 1);
});
