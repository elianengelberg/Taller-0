// Analíticas de participación y coaching de una reunión, calculadas SOLO con
// lo que ya guardamos (quién dijo qué, cuándo, en qué idioma). Cero IA, cero
// costo, cero infraestructura nueva: es aritmética sobre el transcripto.
//
// Es lo que Read AI cobra como "talk time / coaching / engagement" -- acá
// sale gratis del mismo transcripto que además tiene subtítulos traducidos en
// vivo, que Read AI no ofrece. Función pura: se prueba con números exactos.

export interface AnaliticaHablante {
  nombre: string;
  palabras: number;
  intervenciones: number;
  // Porcentaje del total de palabras dichas (0-100), redondeado.
  porcentaje: number;
  // Palabras por minuto de ESTA persona (ritmo). null si no se puede medir
  // (una sola intervención: no hay lapso sobre el cual promediar).
  ritmo: number | null;
  // Muletillas detectadas (según el idioma de cada línea).
  muletillas: number;
}

export interface AnaliticaReunion {
  hablantes: AnaliticaHablante[];
  totalPalabras: number;
  // Minutos de conversación (de la primera a la última línea de voz).
  duracionMin: number;
  // Ritmo global de la reunión, palabras por minuto. null si no medible.
  ritmoGlobal: number | null;
  // El que más habló y el que menos (para el resumen de una línea). null si
  // hubo un solo hablante.
  masHablo: string | null;
  menosHablo: string | null;
}

// Muletillas por idioma (prefijo de dos letras del sourceLang). Son las
// palabras de relleno que el coaching marca: "eh", "este", "o sea"... Se
// comparan en minúsculas y sin signos, como palabras enteras.
const MULETILLAS: Record<string, string[]> = {
  es: ["eh", "este", "esto", "o sea", "osea", "digamos", "viste", "tipo", "nada", "bueno", "em", "mmm"],
  en: ["um", "uh", "like", "you know", "i mean", "actually", "basically", "so", "right", "er", "hmm"],
  pt: ["né", "tipo", "então", "assim", "sabe", "cara", "aí", "hã", "hum"],
  fr: ["euh", "bah", "ben", "genre", "quoi", "voilà", "du coup", "en fait"],
  it: ["ehm", "cioè", "tipo", "insomma", "praticamente", "diciamo", "allora"],
  de: ["äh", "ähm", "halt", "also", "quasi", "sozusagen", "genau"],
  zh: ["那个", "这个", "就是", "然后", "嗯"],
  ja: ["えーと", "あの", "その", "まあ", "なんか", "えっと"],
};

function short(lang: string | null | undefined): string {
  return (lang || "es").split("-")[0].toLowerCase();
}

// Cuenta "palabras". Los idiomas sin espacios (chino, japonés) se miden por
// caracteres no-espacio para no dar 1 en una frase entera.
function contarPalabras(texto: string, lang: string): number {
  const limpio = texto.trim();
  if (!limpio) return 0;
  if (lang === "zh" || lang === "ja") {
    return (limpio.match(/[^\s]/gu) || []).length;
  }
  return limpio.split(/\s+/).filter(Boolean).length;
}

function contarMuletillas(texto: string, lang: string): number {
  const lista = MULETILLAS[lang];
  if (!lista) return 0;
  const t = ` ${texto.toLowerCase().replace(/[.,!?¡¿;:()"'—–-]/g, " ").replace(/\s+/g, " ")} `;
  let n = 0;
  for (const m of lista) {
    // Palabra entera: rodeada de espacios, no una subcadena ("so" no cuenta
    // dentro de "también"). Para las frases ("o sea") va igual.
    let desde = 0;
    const aguja = ` ${m} `;
    for (;;) {
      const i = t.indexOf(aguja, desde);
      if (i === -1) break;
      n += 1;
      desde = i + 1;
    }
  }
  return n;
}

interface LineaVoz {
  senderName: string;
  text: string;
  sourceLang: string | null;
  createdAt: string;
  kind: "chat" | "transcript";
}

export function analizarReunion(mensajes: LineaVoz[]): AnaliticaReunion {
  const voz = mensajes.filter((m) => m.kind === "transcript" && m.text?.trim());
  if (voz.length === 0) {
    return { hablantes: [], totalPalabras: 0, duracionMin: 0, ritmoGlobal: null, masHablo: null, menosHablo: null };
  }

  const porNombre = new Map<
    string,
    { palabras: number; intervenciones: number; muletillas: number; primera: number; ultima: number }
  >();
  let totalPalabras = 0;
  let tMin = Infinity;
  let tMax = -Infinity;

  for (const m of voz) {
    const lang = short(m.sourceLang);
    const palabras = contarPalabras(m.text, lang);
    const muletillas = contarMuletillas(m.text, lang);
    const t = new Date(m.createdAt).getTime();
    const nombre = m.senderName?.trim() || "Participante";
    const acc = porNombre.get(nombre) ?? { palabras: 0, intervenciones: 0, muletillas: 0, primera: t, ultima: t };
    acc.palabras += palabras;
    acc.intervenciones += 1;
    acc.muletillas += muletillas;
    if (Number.isFinite(t)) {
      acc.primera = Math.min(acc.primera, t);
      acc.ultima = Math.max(acc.ultima, t);
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
    }
    porNombre.set(nombre, acc);
    totalPalabras += palabras;
  }

  const hablantes: AnaliticaHablante[] = Array.from(porNombre.entries())
    .map(([nombre, a]) => {
      const lapsoMin = a.ultima > a.primera ? (a.ultima - a.primera) / 60000 : 0;
      return {
        nombre,
        palabras: a.palabras,
        intervenciones: a.intervenciones,
        porcentaje: totalPalabras > 0 ? Math.round((a.palabras / totalPalabras) * 100) : 0,
        // Ritmo sólo si hay un lapso real (al menos ~5 s) sobre el que promediar.
        ritmo: lapsoMin >= 0.08 ? Math.round(a.palabras / lapsoMin) : null,
        muletillas: a.muletillas,
      };
    })
    .sort((x, y) => y.palabras - x.palabras);

  const duracionMin = Number.isFinite(tMin) && tMax > tMin ? (tMax - tMin) / 60000 : 0;
  const ritmoGlobal = duracionMin >= 0.08 ? Math.round(totalPalabras / duracionMin) : null;

  return {
    hablantes,
    totalPalabras,
    duracionMin: Math.round(duracionMin * 10) / 10,
    ritmoGlobal,
    masHablo: hablantes.length > 1 ? hablantes[0].nombre : null,
    menosHablo: hablantes.length > 1 ? hablantes[hablantes.length - 1].nombre : null,
  };
}
