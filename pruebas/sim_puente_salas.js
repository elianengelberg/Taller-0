// El bridge generalizado: una sala companion por CLAVE de sala, para
// cualquier plataforma -- no sólo Meet. Contra el servidor real (puerto 4001).
//
// Lo que de verdad se está probando acá es la identidad: que la extensión
// (bridge REST) y la web (socket join-companion) con la MISMA clave caigan en
// la MISMA sala, y que sus transcripciones se fundan en un solo hilo.
const { io } = require("/home/user/Taller-0/client/node_modules/socket.io-client");
const { Client } = require("/home/user/Taller-0/server/node_modules/pg");
const API = "http://localhost:4001";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  let body = {};
  try { body = JSON.parse(await res.text()); } catch {}
  return { status: res.status, body };
}
const json = (b) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

(async () => {
  const pg = new Client({ connectionString: "postgres://postgres@localhost:5433/unify" });
  await pg.connect();

  // ═══════ 1. Claves válidas por plataforma ═══════
  console.log("\n── 1. Qué claves acepta el bridge ──");
  const zoomKey = `zoom:9${Date.now() % 1e9}${Math.floor(Math.random() * 9)}`;
  for (const [nombre, key, esperado] of [
    ["Zoom", zoomKey, 200],
    ["Teams (thread id)", `teams:19:meeting_${rnd(12)}@thread.v2`, 200],
    ["Jitsi con sala", `jitsi:meet.jit.si/sala-${rnd(6)}`, 200],
    ["Webex", `webex:acme.webex.com/meet/juan${rnd(4)}`, 200],
    ["código de Meet pelado (extensión v3 instalada)", "abc-defg-hij", 200],
    ["plataforma inventada", `hackme:${rnd(8)}`, 400],
    ["sin plataforma", rnd(12), 400],
    ["con espacios (inyección)", "zoom:123 456", 400],
    ["clave kilométrica", `zoom:${"9".repeat(500)}`, 400],
  ]) {
    const r = await api(`/api/meet-bridge/${encodeURIComponent(key)}/session`);
    check(`${nombre} -> ${esperado}`, r.status === esperado, `HTTP ${r.status}`);
  }

  // ═══════ 2. El código de Meet pelado y su clave larga son LA MISMA sala ═══════
  console.log("\n── 2. Compatibilidad con la extensión v3 ──");
  {
    const code = `${rnd(3)}-${rnd(4)}-${rnd(3)}`;
    const viejo = await api(`/api/meet-bridge/${code}/session`);
    const nuevo = await api(`/api/meet-bridge/${encodeURIComponent(`google-meet:${code}`)}/session`);
    check("código pelado y clave completa devuelven el MISMO dbId",
      viejo.body.dbId && viejo.body.dbId === nuevo.body.dbId,
      `${viejo.body.dbId} vs ${nuevo.body.dbId}`);
  }

  // ═══════ 3. La sala de Zoom queda en el historial con su nombre ═══════
  console.log("\n── 3. El historial dice de qué plataforma vino ──");
  {
    const s = await api(`/api/meet-bridge/${encodeURIComponent(zoomKey)}/session`);
    check("la sala de Zoom tiene reunión de respaldo", Boolean(s.body.dbId), s.body.dbId);
    const { rows } = await pg.query(`SELECT host_name FROM meetings WHERE id = $1`, [s.body.dbId]);
    check("y en la base figura como reunión de Zoom", rows[0]?.host_name === "Zoom", rows[0]?.host_name);
    const otraVez = await api(`/api/meet-bridge/${encodeURIComponent(zoomKey)}/session`);
    check("pedir la sesión de nuevo NO crea otra reunión", otraVez.body.dbId === s.body.dbId);
  }

  // ═══════ 4. Extensión y web en la MISMA sala ═══════
  console.log("\n── 4. El overlay y el companion web se funden ──");
  {
    const key = `zoom:8${Date.now() % 1e9}${Math.floor(Math.random() * 9)}`;

    const socket = io(API, { transports: ["websocket"] });
    const lineas = [];
    socket.on("transcript-line", (p) => lineas.push(p.line));
    const joined = await new Promise((resolve) => {
      socket.emit("join-companion", { externalKey: key, name: "Web Companion", language: "es-AR" }, (ack) => resolve(ack));
      setTimeout(() => resolve(null), 4000);
    });
    check("la web entra a la sala companion por socket", Boolean(joined?.ok ?? joined?.meetingId ?? joined), JSON.stringify(joined)?.slice(0, 60));

    const linea = await api(`/api/meet-bridge/${encodeURIComponent(key)}/transcript`,
      json({ speaker: "Ana de Zoom", text: "Hola desde el overlay", lang: "es-AR" }));
    check("el bridge acepta la línea", linea.status === 200, `HTTP ${linea.status}`);
    await sleep(700);
    check("y la web la ve EN VIVO por el socket (misma sala, no una isla)",
      lineas.some((l) => l.text === "Hola desde el overlay" && l.speakerName === "Ana de Zoom"),
      `líneas=${lineas.length}`);

    const s = await api(`/api/meet-bridge/${encodeURIComponent(key)}/session`);
    check("el overlay la lee al sondear /session",
      (s.body.transcript ?? []).some((l) => l.text === "Hola desde el overlay"));
    check("y ve a la participante web en la lista",
      (s.body.participants ?? []).some((p) => p.name === "Web Companion"));
    check("los participantes traen avatarUrl (aunque sea null)",
      (s.body.participants ?? []).every((p) => "avatarUrl" in p));

    const { rows } = await pg.query(
      `SELECT sender_name, text FROM messages WHERE meeting_id = $1 AND kind = 'transcript'`,
      [s.body.dbId]
    );
    check("la línea queda guardada en el historial",
      rows.some((r) => r.text === "Hola desde el overlay" && r.sender_name === "Ana de Zoom"),
      `guardadas=${rows.length}`);
    socket.close();
  }

  // ═══════ 5. El estado del bridge llega a la sala correcta ═══════
  console.log("\n── 5. El estado en vivo (participantes, mute) ──");
  {
    const key = `jitsi:meet.jit.si/estado-${rnd(6)}`;
    const socket = io(API, { transports: ["websocket"] });
    let estado = null;
    socket.on("meet-state", (s) => { estado = s; });
    await new Promise((resolve) => {
      socket.emit("join-companion", { externalKey: key, name: "Mira Estado", language: "es-AR" }, resolve);
      setTimeout(resolve, 4000);
    });
    const r = await api(`/api/meet-bridge/${encodeURIComponent(key)}`,
      json({ inCall: true, participantCount: 7, micMuted: true }));
    check("el bridge acepta el estado", r.status === 200, `HTTP ${r.status}`);
    await sleep(700);
    check("y la sala companion lo recibe (ya no está clavado a GOOGLE-MEET)",
      estado?.participantCount === 7 && estado?.micMuted === true,
      JSON.stringify(estado)?.slice(0, 80));
    socket.close();
  }

  // ═══════ 6. La derivación de claves del injector ESPEJA a la web ═══════
  console.log("\n── 6. Una sola fuente de verdad para las claves ──");
  {
    // Se corre la derivación REAL de la web (meetingPlatforms.ts, vía tsx) y
    // la del injector (extraída de prompt-injector.js) sobre las mismas URLs.
    // Si alguna difiere, el overlay fabricaría una isla: eso es lo que este
    // bloque hace imposible de romper sin enterarse.
    const { execFileSync } = require("child_process");
    const URLS = [
      "https://us05web.zoom.us/j/91234567890?pwd=abc123",
      "https://acme.zoom.us/wc/98765432109/join",
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzId%40thread.v2/0?context=%7b%7d",
      "https://teams.live.com/meet/9351287312?p=clave",
      "https://meet.jit.si/SalaDePrueba",
      "https://8x8.vc/empresa/sala-grande",
    ];
    const out = execFileSync("npx", ["tsx", "-e", `
      import { detectMeetingPlatform } from "/home/user/Taller-0/client/src/lib/meetingPlatforms";
      const urls = ${JSON.stringify(URLS)};
      console.log(JSON.stringify(urls.map(u => detectMeetingPlatform(u, { selfHosts: [] }).roomKey ?? null)));
    `], { cwd: "/home/user/Taller-0/client", encoding: "utf8" });
    const webKeys = JSON.parse(out.trim().split("\n").pop());

    const fs = require("fs");
    const src = fs.readFileSync("/home/user/Taller-0/extension/prompt-injector.js", "utf8");
    const cuerpo = src.match(/function detectar\(\) \{[\s\S]*?\n  \}/)[0];
    const extKeys = URLS.map((u) => {
      const sandbox = new Function("location", `
        function safeDecode(v){ try { return decodeURIComponent(v); } catch { return v; } }
        ${cuerpo}
        return detectar();
      `);
      const url = new URL(u);
      return sandbox({ href: u, hostname: url.hostname })?.roomKey ?? null;
    });

    for (let i = 0; i < URLS.length; i++) {
      check(`misma clave para ${URLS[i].slice(8, 46)}…`,
        webKeys[i] !== null && webKeys[i] === extKeys[i],
        `web=${webKeys[i]} ext=${extKeys[i]}`);
    }
  }

  await pg.end();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
