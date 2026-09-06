// EL RECORTE DE LO YA DICHO (repetidos.ts), con lo que pasó de verdad: el
// reconocedor de Chrome, con habla larga, entregó el mismo párrafo varias
// veces (un final por segmento y un interino ACUMULADO rescatado al morir la
// sesión) y la transcripción lo repetía y seguía. Prueba las TRES copias.
//   server/node_modules/.bin/tsx pruebas/sim_repetidos.ts
import { recortarRepetido as web, crearMemoriaDeRepetidos as memoriaWeb } from "../client/src/lib/repetidos";
import { recortarRepetido as servidor } from "../server/src/repetidos";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
(globalThis as unknown as { window: Record<string, unknown> }).window = {};
require("../extension/repetidos.js");
const ext = (globalThis as unknown as { window: { __unifyRepetidos: { recortarRepetido: (p: string, n: string) => string } } }).window.__unifyRepetidos;

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};
const tres = (p: string, n: string) => {
  const a = web(p, n), b = servidor(p, n), c = ext.recortarRepetido(p, n);
  return { igual: a === b && b === c, valor: a };
};

const A = "dejaron de funcionar el mismo día a la misma hora y nadie sabe si fue una coincidencia y es que el jueves 3 de septiembre hubo un apagón, los tres grandes de la Inteligencia artificial sin notar a Google en los modelos";
const B = "chinos dejaron de funcionar simultáneamente Pero qué explicaciones han dado las compañías, Pues bien, El primero en dar una explicación fue";

// 1) La foto del usuario: A, después A entera otra vez (con mayúscula), después B.
{
  const r = tres(A, "Dejaron de funcionar el mismo día a la misma hora y nadie sabe si fue una coincidencia Y es que el jueves 3 de septiembre hubo un apagón, los tres grandes de la Inteligencia artificial sin notar a Google en los modelos");
  check("el mismo párrafo repetido (cambian mayúsculas) se descarta entero", r.igual && r.valor === "", JSON.stringify(r.valor).slice(0, 60));
}
{
  const r = tres(A, B);
  check("el tramo siguiente, que no repite nada, pasa entero", r.igual && r.valor === B);
}
// 2) El interino ACUMULADO rescatado: A + B junto, con A ya publicada → queda B.
{
  const r = tres(A, `${A} ${B}`);
  check("un acumulado (lo ya dicho + lo nuevo) se recorta a lo nuevo", r.igual && r.valor === B, r.valor.slice(0, 60));
}
// 3) Solape parcial: lo nuevo arranca con las últimas palabras de lo previo.
{
  const r = tres("tenemos que cerrar el presupuesto antes del viernes", "antes del viernes con todo el equipo");
  check("si lo nuevo empieza repitiendo el final de lo previo, se recorta el solape", r.igual && r.valor === "con todo el equipo", r.valor);
}
// 4) Casi igual (el reconocedor cambió una palabra): también es repetido.
{
  const r = tres(A, A.replace("hubo un apagón", "hubo un apagon grande"));
  check("una repetición con una palabra distinta también se descarta", r.igual && r.valor === "", JSON.stringify(r.valor).slice(0, 60));
}
// 5) Frases cortas y repeticiones legítimas: "sí, sí" o "dale" no se tocan.
{
  const r1 = tres("dale", "dale");
  const r2 = tres("sí claro", "sí claro");
  check("dos palabras repetidas (un «dale, dale») NO se recortan: es corto y puede ser real", r1.igual && r1.valor === "dale" && r2.igual && r2.valor === "sí claro");
}
{
  const r = tres("hola a todos", "arrancamos con el presupuesto");
  check("sin solape, pasa tal cual", r.igual && r.valor === "arrancamos con el presupuesto");
}
{
  const r = tres("", "primera frase de la reunión");
  check("sin nada previo, pasa tal cual", r.igual && r.valor === "primera frase de la reunión");
}
// 6) Un tramo dentro de lo previo (más corto): repetido.
{
  const r = tres(`${A} ${B}`, "los tres grandes de la Inteligencia artificial sin notar a Google");
  check("un pedazo del medio de lo ya dicho también se descarta", r.igual && r.valor === "");
}
// 7) La memoria por hablante: cada quien contra lo suyo, y se vence a los 5 min.
{
  const m = memoriaWeb({ vidaMs: 1000 });
  const t0 = 1_000_000;
  check("la memoria recorta contra lo que dijo ESA persona", m.recordar("Ana", A, t0) === A && m.recordar("Ana", `${A} ${B}`, t0 + 100) === B && m.recordar("Bruno", A, t0 + 200) === A);
  check("y pasado el tiempo de vida, lo mismo vuelve a valer", m.recordar("Ana", A, t0 + 5000) === A);
  check("previo() devuelve lo publicado para recortar varias lecturas contra lo mismo", m.previo("Bruno", t0 + 300).endsWith("en los modelos"));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
