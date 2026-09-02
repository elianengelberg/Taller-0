// EL ECO. Dos oídos escuchando la misma voz producen la misma frase dos
// veces, atribuida a quien no habló:
//   - el micrófono de B oye a A por el parlante (dos personas en la misma
//     sala, o cualquiera sin auriculares): "A" y "B" dicen lo mismo;
//   - en Meet, los subtítulos de Google (con nombre) y el oído de la pestaña
//     ("Voces de la reunión") transcriben la misma frase;
//   - en el companion, el micrófono propio y el audio del sistema ("La
//     reunión") oyen a la misma persona remota.
// La transcripción se llenaba de repeticiones. Acá se detecta el duplicado
// por PARECIDO (no igualdad exacta: cada oído comete sus propios errores) y
// con memoria corta: la misma frase repetida un minuto después es legítima.
// Cuando el eco trae un NOMBRE y la línea original era de un oído "sin cara",
// el nombre gana: la línea genérica pasa a ser de quien habló.
import { Meeting, TranscriptLine } from "./types";

export const VENTANA_ECO_MS = 8000;
const MIN_PALABRAS = 4;
const PARECIDO_MINIMO = 0.8;
const LINEAS_A_MIRAR = 12;

// Los hablantes "sin cara": lo que dice un oído que escucha a todos.
const GENERICOS = new Set(["la reunión", "la reunion", "voces de la reunión", "voces de la reunion"]);
export function esHablanteGenerico(nombre: string): boolean {
  const n = nombre.trim().toLowerCase();
  return GENERICOS.has(n) || n.startsWith("pantalla de ");
}

export function palabrasParaEco(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Dice sobre bigramas de palabras: tolera una palabra cambiada (cada oído
// se equivoca distinto) y respeta el orden (las mismas palabras en otro
// orden NO son un eco).
function parecido(a: string[], b: string[]): number {
  const bigramas = (w: string[]) => {
    const s = new Map<string, number>();
    for (let i = 0; i + 1 < w.length; i++) {
      const k = `${w[i]} ${w[i + 1]}`;
      s.set(k, (s.get(k) ?? 0) + 1);
    }
    return s;
  };
  const ba = bigramas(a);
  const bb = bigramas(b);
  let comunes = 0;
  for (const [k, n] of ba) comunes += Math.min(n, bb.get(k) ?? 0);
  const total = a.length - 1 + (b.length - 1);
  return total <= 0 ? 0 : (2 * comunes) / total;
}

// ¿`fragmento` es el eco de `texto` (una línea reciente)? Vale si es casi
// igual, o si cabe ENTERO adentro: el eco suele llegar picado, y la línea
// original ya creció por fusión.
export function esEcoDe(fragmento: string, texto: string): boolean {
  const f = palabrasParaEco(fragmento);
  if (f.length < MIN_PALABRAS) return false;
  const t = palabrasParaEco(texto);
  if (t.length < MIN_PALABRAS) return false;
  if (parecido(f, t) >= PARECIDO_MINIMO) return true;
  if (` ${t.join(" ")} `.includes(` ${f.join(" ")} `)) return true;
  if (t.length > f.length) {
    for (let i = 0; i + f.length <= t.length; i++) {
      if (parecido(f, t.slice(i, i + f.length)) >= PARECIDO_MINIMO) return true;
    }
  }
  return false;
}

// La línea reciente de OTRO hablante de la que `fragmento` es eco, o null.
export function buscarEco(meeting: Meeting, speakerId: string, fragmento: string): TranscriptLine | null {
  const desde = Date.now() - VENTANA_ECO_MS;
  const t = meeting.transcript;
  for (let i = t.length - 1; i >= 0 && i >= t.length - LINEAS_A_MIRAR; i--) {
    const l = t[i];
    if (Math.max(l.timestamp, l.actualizadoEn ?? 0) < desde) continue;
    if (l.speakerId === speakerId) continue;
    if (esEcoDe(fragmento, l.text)) return l;
  }
  return null;
}

// Qué fila del historial respalda cada línea (para renombrar al hablante
// cuando el nombre gana). Acotado: una reunión de horas no lo agranda sin
// fin.
const dbIdPorLinea = new Map<string, number>();
export function recordarFilaDeLinea(lineId: string, dbMessageId: number | null): void {
  if (dbMessageId == null) return;
  if (dbIdPorLinea.size > 4000) {
    const primera = dbIdPorLinea.keys().next().value;
    if (primera !== undefined) dbIdPorLinea.delete(primera);
  }
  dbIdPorLinea.set(lineId, dbMessageId);
}
export function filaDeLinea(lineId: string): number | null {
  return dbIdPorLinea.get(lineId) ?? null;
}
