// UNA TRADUCCIÓN NUNCA PUEDE SER BASURA.
//
// En una reunión de verdad, «hello» apareció traducido como «testvalue» y
// «okay» como «Está bien» (esta última sí estaba bien). El «testvalue» sale de
// la memoria de traducción pública de MyMemory: la escribe cualquiera, y para
// las palabras más comunes está llena de porquería que subió gente probando
// formularios. Su `translatedText` devuelve la mejor coincidencia de esa
// memoria, contaminación incluida.
//
// Mostrar eso es peor que no traducir: parece una traducción, y quien la lee
// no tiene forma de saber que es mentira. Acá se prueba, con respuestas del
// proveedor tal como vienen, que la basura se descarta y que las traducciones
// buenas siguen pasando.
import { elegirDeMyMemory, type RespuestaMyMemory } from "../server/src/translate";

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
};

// ── 1. El caso real: «hello» -> «testvalue» ────────────────────────────────
console.log("\n── La basura de la memoria pública no llega a los subtítulos ──");
{
  // Forma real de la respuesta: la entrada contaminada gana en `responseData`
  // (match 1, la subió una persona) y la traducción de máquina está al lado.
  const respuesta: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "testvalue", match: 1 },
    matches: [
      { translation: "testvalue", quality: "0", match: 1, "created-by": "MateCat" },
      { translation: "hola", quality: "74", match: 0.98, "created-by": "MT!" },
    ],
  };
  const elegida = elegirDeMyMemory(respuesta);
  check("«testvalue» NO se acepta como traducción de «hello»", elegida !== "testvalue", String(elegida));
  check("y en su lugar se toma la de máquina, que sí lo es", elegida === "hola", String(elegida));
}

// ── 2. Sin nada confiable, no se inventa ───────────────────────────────────
{
  const soloBasura: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "asdasd", match: 1 },
    matches: [{ translation: "asdasd", quality: "0", match: 1, "created-by": "anonymous" }],
  };
  check("sin ninguna entrada confiable, se declara que no hay traducción",
    elegirDeMyMemory(soloBasura) === null, String(elegirDeMyMemory(soloBasura)));
}

// ── 3. Una traducción buena sigue pasando ──────────────────────────────────
console.log("\n── Y lo que sí es una traducción sigue pasando ──");
{
  const buena: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "el presupuesto está aprobado", match: 1 },
    matches: [
      { translation: "el presupuesto está aprobado", quality: "74", match: 1, "created-by": "MT!" },
    ],
  };
  check("la traducción de máquina se usa tal cual",
    elegirDeMyMemory(buena) === "el presupuesto está aprobado", String(elegirDeMyMemory(buena)));
}
{
  // Sin `matches` (respuesta mínima del proveedor) y con coincidencia alta.
  const sinMatches: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "Está bien", match: 1 },
  };
  check("una respuesta sin `matches` pero con coincidencia exacta también",
    elegirDeMyMemory(sinMatches) === "Está bien", String(elegirDeMyMemory(sinMatches)));
}
{
  const humanaExacta: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "buenos días", match: 1 },
    matches: [{ translation: "buenos días", quality: "80", match: 1, "created-by": "PersonaReal" }],
  };
  check("una entrada humana exacta y de buena calidad vale igual",
    elegirDeMyMemory(humanaExacta) === "buenos días", String(elegirDeMyMemory(humanaExacta)));
}

// ── 4. Los carteles de error del proveedor nunca son traducción ────────────
console.log("\n── Los errores del proveedor no se muestran como si fueran texto ──");
{
  const error: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "'AUTO' IS AN INVALID SOURCE LANGUAGE", match: 1 },
  };
  check("«'AUTO' IS AN INVALID SOURCE LANGUAGE» no se muestra",
    elegirDeMyMemory(error) === null, String(elegirDeMyMemory(error)));

  const cuota: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS", match: 1 },
    matches: [{ translation: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS", quality: "70", match: 1, "created-by": "MT!" }],
  };
  check("el cartel de cuota agotada tampoco, ni firmado por la máquina",
    elegirDeMyMemory(cuota) === null, String(elegirDeMyMemory(cuota)));
}

// ── 5. Coincidencia floja: mejor el original ───────────────────────────────
{
  const floja: RespuestaMyMemory = {
    responseStatus: 200,
    responseData: { translatedText: "cualquier cosa", match: 0.4 },
  };
  check("una coincidencia floja se descarta (mejor la frase en su idioma)",
    elegirDeMyMemory(floja) === null, String(elegirDeMyMemory(floja)));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
