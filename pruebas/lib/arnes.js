// El arnés compartido de las suites: PASS / FAIL / SKIP con las reglas de la
// casa.
//
//   - check(nombre, ok, detalle): lo de siempre.
//   - skip(nombre, motivo): la prueba NO pudo probar lo que dice (falta el
//     entorno, el navegador no soporta la API). Se imprime y se cuenta aparte:
//     un SKIP nunca es un PASS.
//   - exigir(locator, nombre): un elemento que TIENE que estar. Si no está,
//     es FAIL (antes muchas suites hacían `if (await x.count()) {...}` y, si
//     el botón desaparecía, saltaban el paso en silencio y seguían en verde).
//   - resumen(): imprime "N/M OK (k SKIP)" y sale con 1 si hubo un FAIL.
//
// Uso:
//   const { check, skip, exigir, resumen } = require("./lib/arnes")("sim_x");
//   ...
//   resumen();

module.exports = function crearArnes(nombreSuite = "") {
  const resultados = []; // true = PASS, false = FAIL
  let saltos = 0;

  function check(nombre, ok, detalle = "") {
    resultados.push(Boolean(ok));
    console.log(`${ok ? "PASS" : "FAIL"} ${nombre}${detalle ? " — " + detalle : ""}`);
    return Boolean(ok);
  }

  function skip(nombre, motivo = "") {
    saltos += 1;
    console.log(`SKIP ${nombre}${motivo ? " — " + motivo : ""}`);
    return false;
  }

  // Devuelve true si el elemento está (y sigue el flujo); si no, registra
  // el FAIL con el nombre pedido y devuelve false para que quien llama corte.
  async function exigir(locator, nombre, detalle = "") {
    let n = 0;
    try {
      n = await locator.count();
    } catch {
      n = 0;
    }
    if (n > 0) return true;
    check(nombre, false, detalle || "no está en la pantalla");
    return false;
  }

  function resumen() {
    const fallas = resultados.filter((r) => !r).length;
    const extra = saltos ? ` (${saltos} SKIP)` : "";
    console.log(`\n${resultados.length - fallas}/${resultados.length} OK${extra}${nombreSuite ? `  [${nombreSuite}]` : ""}`);
    process.exit(fallas ? 1 : 0);
  }

  return { check, skip, exigir, resumen, resultados };
};
