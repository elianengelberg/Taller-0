// VOZ REALISTA para las suites. El reconocimiento de voz del navegador no
// existe en el arnés (Chromium sin las llaves de Google), así que las suites
// fingen el objeto SpeechRecognition. Hasta ahora le mandaban un "final"
// limpio y listo; la vida real no es así: el reconocedor escribe palabra por
// palabra (interinos), se corrige a mitad de frase, a veces retracta lo que
// dijo (no-speech), entrega el final con lecturas alternativas y CONFUNDE
// palabras que suenan parecido. Esto reproduce eso, con frases de reuniones
// de verdad y sus errores típicos, para que lo que pasa la prueba sea lo que
// pasa en una reunión.
//
// Uso en una suite (lado Node):
//   const { CORPUS, guion, INYECTAR_HABLAR } = require("./lib/voz");
//   await page.addInitScript(INYECTAR_HABLAR);          // define window.__hablar
//   await page.evaluate(([pasos]) => window.__hablar(pasos), [guion(CORPUS[0])]);
//
// `guion(frase)` devuelve la secuencia de eventos que el doble de
// SpeechRecognition tiene que emitir; `window.__hablar(pasos)` los emite
// sobre el último reconocedor activo (window.__recs, el doble de las suites).

const CORPUS = [
  { dicho: "tenemos que cerrar el presupuesto antes del viernes", crudo: "tenemos que cerrar el prosupuesto antes del viernes", alts: ["tenemos que cerrar el presupuesto antes del viernes"] },
  { dicho: "¿cómo andás con el informe del trimestre?", crudo: "comandantes con el informe del trimestre", alts: ["cómo andás con el informe del trimestre"] },
  { dicho: "la lámina azul muestra la curva de ventas", crudo: "la lamina asul muestra la curba de bentas", alts: ["la lámina azul muestra la curva de ventas"] },
  { dicho: "mañana a las diez hablamos con el cliente nuevo", crudo: "mañana a las diez hablamos con el cliente nuevo", alts: ["mañana a las 10 hablamos con el cliente nuevo"] },
  { dicho: "no lo veo, ¿me lo podés mandar por mail?", crudo: "no lo veo me lo podes mandar por mail", alts: ["no lo veo me lo podés mandar por mail"] },
  { dicho: "el equipo de soporte cerró todos los tickets", crudo: "el equipo de soporte cerro todos los tiques", alts: ["el equipo de soporte cerró todos los tickets"] },
  { dicho: "dale, lo vemos el jueves con todo el equipo", crudo: "dale lo vemos el jueves con todo el equipo", alts: [] },
  { dicho: "hay un tema con los plazos de entrega", crudo: "hay un tema con los plazos de entrega", alts: ["ahí un tema con los plazos de entrega"] },
  { dicho: "necesito la firma del contrato para mañana", crudo: "necesito la firma del contrato para mañana", alts: ["necesito la firma de el contrato para mañana"] },
  { dicho: "vamos a subir el archivo al drive compartido", crudo: "vamos a subir el archivo al draib compartido", alts: ["vamos a subir el archivo al drive compartido"] },
  { dicho: "¿alguien más tiene algo para agregar?", crudo: "alguien mas tiene algo para agregar", alts: ["alguien más tiene algo para agregar"] },
  { dicho: "perfecto, entonces yo preparo la presentación", crudo: "perfecto entonces yo preparo la presentacion", alts: ["perfecto entonces yo preparo la presentación"] },
];

// La secuencia de eventos que emite un reconocedor de verdad para una frase:
// interinos que crecen palabra por palabra (con una corrección a mitad de
// camino, como hace Chrome), y el final con sus alternativas.
//   opciones.retractar: en vez del final, muere en "no-speech" (lo interino
//                       era ruido): la app NO debe rescatarlo.
//   opciones.cortar:    la sesión muere ANTES del final (onend sin final):
//                       la app SÍ debe rescatar lo interino.
//   opciones.pausaMs:   silencio entre pasos (default 90 ms, como escribir).
function guion(frase, opciones = {}) {
  const { retractar = false, cortar = false, pausaMs = 90 } = opciones;
  const palabras = frase.crudo.split(" ");
  const pasos = [];
  // Chrome suele "equivocarse" una palabra en el interino y corregirla en el
  // siguiente: se simula con la penúltima palabra escrita a medias.
  for (let i = 1; i <= palabras.length; i++) {
    let parcial = palabras.slice(0, i).join(" ");
    if (i === Math.max(1, palabras.length - 1) && palabras.length > 3) {
      pasos.push({ tipo: "interino", texto: parcial.slice(0, -2), pausaMs });
    }
    pasos.push({ tipo: "interino", texto: parcial, pausaMs });
  }
  if (retractar) {
    pasos.push({ tipo: "error", error: "no-speech", pausaMs });
    pasos.push({ tipo: "fin", pausaMs });
    return pasos;
  }
  if (cortar) {
    pasos.push({ tipo: "fin", pausaMs });
    return pasos;
  }
  pasos.push({ tipo: "final", texto: frase.crudo, alts: frase.alts, pausaMs });
  return pasos;
}

// Un monólogo sin pausas: varias frases del corpus, seguidas, como habla la
// persona que presenta sin respirar.
function monologo(cantidad = 3, desde = 0) {
  const frases = [];
  for (let i = 0; i < cantidad; i++) frases.push(CORPUS[(desde + i) % CORPUS.length]);
  return {
    dicho: frases.map((f) => f.dicho).join(" "),
    crudo: frases.map((f) => f.crudo).join(" "),
    alts: [frases.map((f) => f.alts[0] || f.crudo).join(" ")],
  };
}

// Se inyecta en la página (addInitScript): emite los pasos sobre el último
// reconocedor activo. Compatible con el doble `window.__recs` de las suites.
const INYECTAR_HABLAR = `
  window.__hablar = async (pasos, quien) => {
    const rec = quien || [...(window.__recs || [])].reverse().find((r) => r.onresult);
    if (!rec) return false;
    const resultado = (texto, alts, isFinal) => {
      const lecturas = [{ transcript: texto }, ...(alts || []).map((a) => ({ transcript: a }))];
      const res = Object.assign(lecturas, { isFinal, length: lecturas.length });
      return { resultIndex: 0, results: [res] };
    };
    for (const p of pasos) {
      await new Promise((r) => setTimeout(r, p.pausaMs ?? 90));
      if (p.tipo === "interino" && rec.onresult) rec.onresult(resultado(p.texto, [], false));
      else if (p.tipo === "final" && rec.onresult) rec.onresult(resultado(p.texto, p.alts, true));
      else if (p.tipo === "error" && rec.onerror) rec.onerror({ error: p.error });
      else if (p.tipo === "fin" && rec.onend) rec.onend();
    }
    return true;
  };
`;

module.exports = { CORPUS, guion, monologo, INYECTAR_HABLAR };
