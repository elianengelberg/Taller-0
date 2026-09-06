// LO QUE YA SE DIJO NO SE REPITE. El reconocimiento de voz de Chrome, con
// habla larga y sin pausas, entrega el mismo tramo más de una vez: un final
// por segmento, y encima un interino ACUMULADO (toda la sesión desde el
// principio) que al morir la sesión se rescata como final. Resultado: la
// transcripción repetía un párrafo entero y seguía. Esto recorta de un texto
// nuevo lo que ya está al final de lo anterior, y descarta lo que ya se dijo
// completo. Se compara sobre palabras normalizadas (sin tildes, sin
// puntuación, sin mayúsculas), porque el reconocedor cambia eso entre
// lecturas ("Dejaron" / "dejaron", "3" / "tres" no, pero eso es raro).
//
// La MISMA función vive en server/src/repetidos.ts y extension/repetidos.js
// (copias generadas por client/scripts/sync-compartido.mjs).

const MINIMO_SOLAPE = 3; // palabras seguidas iguales para considerarlo repetido
const MINIMO_SOLAPE_LEJOS = 5; // si el tramo repetido no está al final de lo previo

function normalizarPalabra(p: string): string {
  return p
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Palabras normalizadas con su posición en el texto original (para recortar
// el original, no la versión normalizada).
function partir(texto: string): Array<{ palabra: string; desde: number; hasta: number }> {
  const salida: Array<{ palabra: string; desde: number; hasta: number }> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const palabra = normalizarPalabra(m[0]);
    if (palabra) salida.push({ palabra, desde: m.index, hasta: m.index + m[0].length });
  }
  return salida;
}

function bigramas(palabras: string[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + 1 < palabras.length; i++) s.add(`${palabras[i]} ${palabras[i + 1]}`);
  return s;
}

// Devuelve la parte de `nuevo` que NO está ya al final de `previo`:
//  - "" si `nuevo` ya se dijo entero (contenido en `previo`, o casi: ≥ 85 %
//    de sus pares de palabras están en `previo`);
//  - `nuevo` sin las palabras iniciales que repiten el final de `previo`;
//  - `nuevo` tal cual si no hay solape.
export function recortarRepetido(previo: string, nuevo: string): string {
  const N = partir(nuevo);
  if (N.length === 0) return "";
  const P = partir(previo || "").slice(-200).map((x) => x.palabra);
  if (P.length === 0) return nuevo.trim();
  const n = N.map((x) => x.palabra);

  // 1) Ya dicho entero: aparece contiguo dentro de lo previo.
  if (n.length >= MINIMO_SOLAPE) {
    const pStr = ` ${P.join(" ")} `;
    if (pStr.includes(` ${n.join(" ")} `)) return "";
    // ...o casi entero (el reconocedor cambió una palabra suelta).
    if (n.length >= 5) {
      const bn = bigramas(n);
      const bp = bigramas(P);
      let comunes = 0;
      for (const b of bn) if (bp.has(b)) comunes++;
      if (comunes / bn.size >= 0.85) return "";
    }
  }

  // 2) El principio de lo nuevo repite el final de lo previo: se recorta el
  //    solape más largo (mínimo MINIMO_SOLAPE palabras).
  const tope = Math.min(P.length, n.length);
  for (let k = tope; k >= MINIMO_SOLAPE; k--) {
    let igual = true;
    for (let i = 0; i < k; i++) {
      if (P[P.length - k + i] !== n[i]) {
        igual = false;
        break;
      }
    }
    if (igual) {
      if (k === n.length) return "";
      return nuevo.slice(N[k].desde).trim();
    }
  }

  // 3) El principio de lo nuevo repite un tramo LARGO de lo previo, aunque no
  //    sea el final (un acumulado que se salteó algo): también se recorta.
  const pStr = ` ${P.join(" ")} `;
  for (let k = n.length - 1; k >= MINIMO_SOLAPE_LEJOS; k--) {
    if (pStr.includes(` ${n.slice(0, k).join(" ")} `)) return nuevo.slice(N[k].desde).trim();
  }
  return nuevo.trim();
}

// La memoria de "lo último que dijo cada uno", acotada, para aplicar el
// recorte frase a frase: `recordar(quien, texto)` devuelve lo que queda por
// publicar (o "") y lo anota.
export function crearMemoriaDeRepetidos(opciones: { palabras?: number; vidaMs?: number } = {}) {
  const { palabras = 200, vidaMs = 5 * 60_000 } = opciones;
  const porQuien = new Map<string, { texto: string; en: number }>();
  const previoDe = (quien: string, ahora: number): string => {
    const guardado = porQuien.get(quien || "");
    return guardado && ahora - guardado.en < vidaMs ? guardado.texto : "";
  };
  const anotar = (quien: string, texto: string, ahora = Date.now()): void => {
    const vigente = previoDe(quien, ahora);
    const junto = `${vigente} ${texto}`.trim().split(/\s+/).slice(-palabras).join(" ");
    porQuien.set(quien || "", { texto: junto, en: ahora });
  };
  return {
    // Lo que ya se publicó de esa fuente (para recortar varias lecturas
    // candidatas contra lo mismo).
    previo(quien: string, ahora = Date.now()): string {
      return previoDe(quien, ahora);
    },
    anotar,
    recordar(quien: string, texto: string, ahora = Date.now()): string {
      const queda = recortarRepetido(previoDe(quien, ahora), texto);
      if (queda) anotar(quien, queda, ahora);
      return queda;
    },
    olvidar(quien?: string) {
      if (quien === undefined) porQuien.clear();
      else porQuien.delete(quien);
    },
  };
}
