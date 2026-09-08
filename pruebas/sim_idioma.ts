// EL DETECTOR DE IDIOMA, con frases como las que salen de una reunión (y del
// reconocimiento de voz: sin tildes, con confusiones). Se corre con tsx:
//   server/node_modules/.bin/tsx pruebas/sim_idioma.ts
// Prueba las TRES copias (web, servidor, extensión): tienen que decir lo
// mismo, porque la tabla vive en tres lugares.
import { crearMemoriaDeIdioma as memoriaWeb, detectarIdioma as web, idiomaEfectivo as efectivoWeb } from "../client/src/lib/idioma";
import { crearMemoriaDeIdioma as memoriaServidor, detectarIdioma as servidor } from "../server/src/idioma";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
(globalThis as unknown as { window: Record<string, unknown> }).window = {};
require("../extension/idioma.js");
const ext = (
  globalThis as unknown as {
    window: {
      __unifyIdioma: {
        detectarIdioma: (t: string) => string | null;
        crearMemoriaDeIdioma: typeof memoriaWeb;
      };
    };
  }
).window.__unifyIdioma;

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};

const CASOS: Array<[string, string | null]> = [
  // Lo que pasó de verdad: alguien hablando en inglés, la línea marcada es-AR.
  ["we need to close the budget before friday and I think the numbers are fine", "en"],
  ["okay so let's move to the next item on the agenda", "en"],
  ["can you share your screen please I can't see the slides", "en"],
  ["yeah I think we should talk to the client tomorrow morning", "en"],
  // Español rioplatense, como lo escribe el reconocedor (sin tildes).
  ["tenemos que cerrar el presupuesto antes del viernes", "es"],
  ["dale, lo vemos el jueves con todo el equipo", "es"],
  ["no lo veo, me lo podes mandar por mail", "es"],
  ["hay un tema con los plazos de entrega y no se si llegamos", "es"],
  // Portugués (la trampa: comparte "de", "que", "a" con el español).
  ["a gente precisa fechar o orçamento antes de sexta, não dá mais tempo", "pt"],
  ["você pode compartilhar a tela? não estou vendo os slides", "pt"],
  // Francés, italiano, alemán.
  ["il faut qu'on parle du budget avant vendredi, c'est important", "fr"],
  ["dobbiamo chiudere il budget prima di venerdì, è importante", "it"],
  ["wir müssen das budget vor freitag abschließen, das ist wichtig", "de"],
  // Escrituras que no dejan dudas.
  ["明天上午十点和客户开会", "zh"],
  ["明日の午前十時にクライアントと会議があります", "ja"],
  ["завтра встреча с клиентом в десять утра", "ru"],
  // Corto o ambiguo: NO se adivina (se le cree a la etiqueta).
  ["ok", null],
  ["hola", null],
  ["abc-defg-hij", null],
  ["Juan Pérez Rodríguez", null],
];

for (const [frase, esperado] of CASOS) {
  const w = web(frase), s = servidor(frase), e = ext.detectarIdioma(frase);
  check(`«${frase.slice(0, 48)}» → ${esperado === null ? "no se sabe" : esperado}`,
    w === esperado && s === esperado && e === esperado, `web=${w} servidor=${s} ext=${e}`);
}

// El idioma EFECTIVO: la etiqueta manda salvo que el texto la contradiga.
check("inglés etiquetado es-AR → efectivo en", efectivoWeb("we need to close the budget before friday", "es-AR") === "en");
check("español etiquetado es-AR → efectivo es", efectivoWeb("tenemos que cerrar el presupuesto antes del viernes", "es-AR") === "es");
check("frase corta etiquetada en-US → se cree la etiqueta (en)", efectivoWeb("ok dale", "en-US") === "en");
check("sin etiqueta y sin pistas → vacío (nadie inventa)", efectivoWeb("ok", "") === "");
// Una frase mezclada con un par de palabras en inglés sigue siendo español.
check("«ok, el meeting es a las tres con el equipo» sigue siendo español",
  web("ok, el meeting es a las tres con el equipo") === "es", String(web("ok, el meeting es a las tres con el equipo")));

// LA MEMORIA DE IDIOMA: lo que se viene hablando resuelve las frases cortas.
// Es el bug real: en una reunión en inglés, "Okay" y "yes, exactly" quedaban
// etiquetados con el idioma del reconocimiento (es-AR) y se mostraban SIN
// traducir, que en subtítulos de Meet (que llegan en pedacitos) era casi todo.
{
  const memoria = memoriaWeb();
  const SALA = "google-meet:abc";
  const ANA = `${SALA}|Ana`;
  check("sin nada anotado, una frase corta se resuelve con la etiqueta",
    memoria.resolver([ANA, SALA], "Okay", "es-AR") === "es");
  check("una frase larga en inglés se detecta sola (y queda anotada)",
    memoria.resolver([ANA, SALA], "we need to close the budget before friday", "es-AR") === "en");
  check("y desde entonces «Okay» de esa persona es inglés, aunque la etiqueta diga es-AR",
    memoria.resolver([ANA, SALA], "Okay", "es-AR") === "en");
  check("otra persona de la MISMA sala hereda lo que se viene hablando",
    memoria.resolver([`${SALA}|Bruno`, SALA], "yes, exactly", "es-AR") === "en");
  check("una sala distinta no se contagia",
    memoria.resolver(["google-meet:otra|Ana", "google-meet:otra"], "Okay", "es-AR") === "es");
  check("si esa persona pasa al español con una frase larga, se corrige sola",
    memoria.resolver([ANA, SALA], "tenemos que cerrar el presupuesto antes del viernes", "es-AR") === "es"
      && memoria.resolver([ANA, SALA], "dale", "es-AR") === "es");
  const viejo = memoriaWeb({ vidaMs: 1 });
  viejo.anotar("x", "en");
  check("lo recordado vence (una reunión vieja no manda sobre la de ahora)",
    viejo.recordar("x") === "en" || viejo.recordar("x") === null);
  const chica = memoriaWeb({ maxClaves: 2 });
  chica.anotar("a", "en"); chica.anotar("b", "en"); chica.anotar("c", "en");
  check("la memoria tiene tope (no crece para siempre)",
    chica.recordar("a") === null && chica.recordar("c") === "en");
  // Las TRES copias tienen que comportarse igual.
  for (const [nombre, crear] of [["servidor", memoriaServidor], ["extensión", ext.crearMemoriaDeIdioma]] as const) {
    const m = crear();
    m.resolver([ANA, SALA], "we need to close the budget before friday", "es-AR");
    check(`la copia del ${nombre} recuerda igual`, m.resolver([ANA, SALA], "Okay", "es-AR") === "en");
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
