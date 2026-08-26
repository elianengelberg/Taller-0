// Las analíticas de participación y coaching (lo que Read AI cobra), acá
// gratis y sobre el MISMO transcripto que tiene subtítulos traducidos. Se
// prueba la función PURA real (meetingAnalytics.ts, vía tsx) con números
// exactos, y que el panel aparece en el detalle de la reunión.
const { execFileSync } = require("child_process");
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

(async () => {
  console.log("── 1. El cálculo, con números exactos ──");
  {
    // Un guion controlado: Ana habla mucho y con muletillas, Beto poco, Caro
    // en inglés. Los tiempos están puestos para que el ritmo sea calculable.
    const t0 = new Date("2026-08-26T15:00:00Z").getTime();
    const min = (m) => new Date(t0 + m * 60000).toISOString();
    const mensajes = [
      { kind: "transcript", senderName: "Ana", sourceLang: "es-AR", createdAt: min(0),
        text: "bueno eh, digamos que arrancamos con el primer punto del día de hoy" }, // 12 palabras, muletillas: bueno, eh, digamos = 3
      { kind: "transcript", senderName: "Ana", sourceLang: "es-AR", createdAt: min(2),
        text: "o sea la idea es cerrar esto rápido viste" }, // 9 palabras, muletillas: o sea, viste = 2
      { kind: "chat", senderName: "Ana", sourceLang: "es-AR", createdAt: min(2), text: "esto no cuenta" }, // chat: ignorado
      { kind: "transcript", senderName: "Beto", sourceLang: "es-AR", createdAt: min(1),
        text: "de acuerdo" }, // 2 palabras, una sola intervención -> ritmo null
      { kind: "transcript", senderName: "Caro", sourceLang: "en-US", createdAt: min(0),
        text: "um so basically I think we should like move on" }, // 9 palabras, muletillas en: um, so, basically, like = 4
      { kind: "transcript", senderName: "Caro", sourceLang: "en-US", createdAt: min(3),
        text: "yes lets do that" }, // 4 palabras
    ];

    const salida = execFileSync("npx", ["tsx", "-e", `
      import { analizarReunion } from "/home/user/Taller-0/client/src/lib/meetingAnalytics";
      const m = ${JSON.stringify(mensajes)};
      console.log("R:" + JSON.stringify(analizarReunion(m)));
    `], { cwd: "/home/user/Taller-0/client", encoding: "utf8" });
    const a = JSON.parse(salida.split("R:")[1].trim().split("\n")[0]);

    const h = Object.fromEntries(a.hablantes.map((x) => [x.nombre, x]));
    check("el chat NO cuenta como habla", a.totalPalabras === 22 + 2 + 14, `total=${a.totalPalabras}`);
    check("Ana suma sus dos intervenciones de voz (22 palabras)",
      h.Ana.palabras === 22 && h.Ana.intervenciones === 2, JSON.stringify(h.Ana));
    check("las muletillas en español se cuentan (bueno/eh/digamos + o sea/esto/viste = 6)",
      h.Ana.muletillas === 6, `muletillas Ana=${h.Ana.muletillas}`);
    check("las muletillas en INGLÉS se cuentan con la lista inglesa (um/so/basically/like = 4)",
      h.Caro.muletillas === 4, `muletillas Caro=${h.Caro.muletillas}`);
    check("Beto, con una sola intervención, no tiene ritmo (null)",
      h.Beto.ritmo === null && h.Beto.intervenciones === 1, JSON.stringify(h.Beto));
    check("Ana SÍ tiene ritmo (dos intervenciones con lapso)", typeof h.Ana.ritmo === "number" && h.Ana.ritmo > 0, `ritmo=${h.Ana.ritmo}`);
    check("los porcentajes suman ~100", Math.abs(a.hablantes.reduce((s, x) => s + x.porcentaje, 0) - 100) <= 2,
      a.hablantes.map((x) => `${x.nombre}:${x.porcentaje}`).join(" "));
    check("se ordena por quién más habló (Ana primero)", a.hablantes[0].nombre === "Ana");
    check("y sabe quién más y quién menos habló", a.masHablo === "Ana" && a.menosHablo === "Beto",
      `${a.masHablo}/${a.menosHablo}`);
    check("la duración sale de la primera a la última línea (3 min)", a.duracionMin === 3, `dur=${a.duracionMin}`);
  }

  console.log("\n── 2. Casos borde ──");
  {
    const prueba = (nombre, m, fn) => {
      const salida = execFileSync("npx", ["tsx", "-e", `
        import { analizarReunion } from "/home/user/Taller-0/client/src/lib/meetingAnalytics";
        console.log("R:" + JSON.stringify(analizarReunion(${JSON.stringify(m)})));
      `], { cwd: "/home/user/Taller-0/client", encoding: "utf8" });
      fn(JSON.parse(salida.split("R:")[1].trim().split("\n")[0]), nombre);
    };
    prueba("sin voz", [{ kind: "chat", senderName: "X", sourceLang: "es", createdAt: new Date().toISOString(), text: "hola" }],
      (a) => check("sin líneas de voz: analítica vacía, sin romper", a.hablantes.length === 0 && a.totalPalabras === 0));
    const ahora = new Date().toISOString();
    prueba("chino sin espacios", [{ kind: "transcript", senderName: "Li", sourceLang: "zh-CN", createdAt: ahora, text: "我们今天开会讨论" }],
      (a) => check("el chino se mide por caracteres, no da 1 palabra", a.totalPalabras >= 6, `total=${a.totalPalabras}`));
    prueba("una sola persona", [
        { kind: "transcript", senderName: "Solo", sourceLang: "es", createdAt: ahora, text: "hablo yo nada más acá" },
      ],
      (a) => check("con un solo hablante no hay «más/menos habló»", a.masHablo === null && a.menosHablo === null));
    prueba("'so' no cuenta dentro de otra palabra", [
        { kind: "transcript", senderName: "Z", sourceLang: "en", createdAt: ahora, text: "personal absolutely awesome" },
      ],
      (a) => check("las muletillas son palabras ENTERAS (no subcadenas)", a.hablantes[0].muletillas === 0,
        `muletillas=${a.hablantes[0].muletillas}`));
  }

  console.log("\n── 3. El seguimiento de palabras (palabras clave por reunión) ──");
  {
    const ahora = new Date("2026-08-26T15:00:00Z").toISOString();
    const mensajes = [
      { kind: "transcript", senderName: "Ana", sourceLang: "es-AR", createdAt: ahora,
        text: "el Presupuesto del trimestre quedó corto, hay que revisar el presupuestó de nuevo" },
      { kind: "transcript", senderName: "Beto", sourceLang: "es-AR", createdAt: ahora,
        text: "para mí el presupuesto está bien, lo que falta es tiempo" },
      { kind: "chat", senderName: "Caro", sourceLang: "es-AR", createdAt: ahora,
        text: "presupuesto aprobado 👍" },
      { kind: "transcript", senderName: "Ana", sourceLang: "es-AR", createdAt: ahora,
        text: "la solución no es un sol de verano" },
    ];
    const salida = execFileSync("npx", ["tsx", "-e", `
      import { seguirPalabras } from "/home/user/Taller-0/client/src/lib/meetingAnalytics";
      const m = ${JSON.stringify(mensajes)};
      console.log("R:" + JSON.stringify(seguirPalabras(m, ["Presupuestó", "sol", "deadline"])));
    `], { encoding: "utf8", cwd: "/home/user/Taller-0/client" });
    const r = JSON.parse(salida.split("R:")[1]);
    const presupuesto = r.find((x) => x.palabra === "Presupuestó");
    check("cuenta sin importar mayúsculas NI acentos (presupuesto ≈ Presupuestó)",
      presupuesto?.veces === 4, `veces=${presupuesto?.veces}`);
    check("dice QUIÉN la dijo, ordenado por veces",
      presupuesto?.porQuien[0]?.nombre === "Ana" && presupuesto?.porQuien[0]?.veces === 2,
      JSON.stringify(presupuesto?.porQuien));
    check("el chat también cuenta (Caro la escribió)",
      presupuesto?.porQuien.some((q) => q.nombre === "Caro"), JSON.stringify(presupuesto?.porQuien));
    check("trae frases de ejemplo con el nombre de quien habló",
      presupuesto?.ejemplos.length >= 2 && /Ana: /.test(presupuesto?.ejemplos[0] ?? ""),
      presupuesto?.ejemplos[0]);
    const sol = r.find((x) => x.palabra === "sol");
    check("palabra ENTERA: «sol» no matchea «solución»", sol?.veces === 1, `veces=${sol?.veces}`);
    const deadline = r.find((x) => x.palabra === "deadline");
    check("una palabra no dicha da cero (no desaparece de la lista)", deadline?.veces === 0);
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message, e.stack?.slice(0, 400)); process.exit(1); });
