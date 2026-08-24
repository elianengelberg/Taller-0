// Translation provider. When ANTHROPIC_API_KEY is configured, uses Claude
// Haiku (fast + cheap, no extended thinking needed for a short phrase) so
// live captions/chat keep up with a real conversation. Falls back to the
// free, keyless MyMemory API otherwise so the app still works without any
// extra setup -- just slower and less reliable under load.
import { anthropicClient, anthropicEnabled } from "./anthropicClient";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 30;
// Expired entries are only ever *overwritten*, never swept, so on a
// long-running server the map would grow without bound. Cap it: when full,
// evict the oldest entries (Map preserves insertion order).
const CACHE_MAX_ENTRIES = 5000;

function boundedCacheSet(key: string, value: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Deliberately NOT the same (larger, slower) model used for the AI Q&A
// feature: translation is high-volume and latency-sensitive, and a short
// phrase doesn't benefit from extra reasoning power.
const TRANSLATE_MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || "claude-haiku-4-5";

const LANGUAGE_NAMES: Record<string, string> = {
  es: "Spanish",
  en: "English",
  pt: "Portuguese",
  fr: "French",
  it: "Italian",
  de: "German",
  // Explicit about the script, not just the language: mainland China,
  // Singapore, etc. use simplified characters (简体字); Taiwan/Hong Kong use
  // traditional (繁體字). Naming it plainly "Chinese" left the model free to
  // pick either -- this pins every translation/correction to simplified.
  zh: "Simplified Chinese",
  ja: "Japanese",
};

// Same names, but in Spanish -- for dropping into the (Spanish-language)
// cleanup/correction system prompts, where an English name would read as an
// odd word dropped into an otherwise Spanish sentence.
const SPANISH_LANGUAGE_NAMES: Record<string, string> = {
  es: "español",
  en: "inglés",
  pt: "portugués",
  fr: "francés",
  it: "italiano",
  de: "alemán",
  zh: "chino",
  ja: "japonés",
};

// Words from this app itself (chat, share screen, microphone...) come up
// constantly in the conversations being transcribed, since people talk
// about the call they're on, not just their meeting topic -- worth being
// biased toward when a candidate reading is ambiguous (e.g. "chat" getting
// misheard as "champ" happens because "chat" alone is a short, less common
// word for the recognizer to lock onto than it should be here). This used
// to be a single Spanish-only list, which meant it only ever helped Spanish
// speakers -- everyone else's meetings still have this exact same vocabulary
// coming up, just in their own language, so each language below gets its
// own translated anchor list instead.
const DOMAIN_VOCAB: Partial<Record<string, string>> = {
  es: "chat, pantalla, compartir pantalla, micrófono, cámara, subtítulos, transcripción, reunión, grabar, grabación, rol, participante, anfitrión, silenciar",
  en: "chat, screen, share screen, microphone, camera, captions, subtitles, transcript, meeting, record, recording, role, participant, host, mute",
  pt: "chat, tela, compartilhar tela, microfone, câmera, legendas, transcrição, reunião, gravar, gravação, função, participante, anfitrião, silenciar",
  fr: "chat, écran, partager l'écran, microphone, caméra, sous-titres, transcription, réunion, enregistrer, enregistrement, rôle, participant, hôte, muet",
  it: "chat, schermo, condividi schermo, microfono, videocamera, sottotitoli, trascrizione, riunione, registrare, registrazione, ruolo, partecipante, host, silenzia",
  de: "Chat, Bildschirm, Bildschirm teilen, Mikrofon, Kamera, Untertitel, Transkript, Besprechung, aufnehmen, Aufnahme, Rolle, Teilnehmer, Gastgeber, stummschalten",
  zh: "聊天 (chat), 屏幕 (pantalla), 共享屏幕 (compartir pantalla), 麦克风 (micrófono), 摄像头 (cámara), 字幕 (subtítulos), 转录 (transcripción), 会议 (reunión), 录制 (grabar), 角色 (rol), 参与者 (participante), 主持人 (anfitrión), 静音 (silenciar)",
  ja: "チャット (chat), 画面 (pantalla), 画面共有 (compartir pantalla), マイク (micrófono), カメラ (cámara), 字幕 (subtítulos), 文字起こし (transcripción), 会議 (reunión), 録画 (grabar), 役割 (rol), 参加者 (participante), ホスト (anfitrión), ミュート (silenciar)",
};

// Real linguistic knowledge for every language the app offers -- not a
// "training" step (Claude already knows these languages deeply; there's no
// separate study phase to run), but concrete failure patterns worth naming
// so the model actively watches for them instead of just doing generic
// correction/translation. Keyed by short language code.
const LANGUAGE_EXPERTISE: Partial<Record<string, string>> = {
  es:
    "Español: el reconocimiento de voz casi nunca pone tildes, y muchas palabras cambian de " +
    "significado según lleven acento o no -- prestá atención especial a eso: qué/que, cómo/como, " +
    "dónde/donde, sí/si, tú/tu, él/el, más/mas, aún/aun, sé/se. También hay pares que suenan igual o " +
    "casi igual y se confunden seguido: hay/ahí/ay, haber/a ver, vaya/valla/baya, tuvo/tubo, " +
    "echo/hecho, ves/vez. Si la conversación usa \"vos\" (voseo, común en Argentina y otros países de " +
    "América), no lo \"corrijas\" a \"tú\" -- es una forma correcta, no un error de reconocimiento.",
  en:
    "Inglés: hay muchísimos homófonos que el reconocimiento confunde según el contexto -- " +
    "there/their/they're, to/too/two, your/you're, its/it's, here/hear, right/write, know/no, " +
    "meet/meat, board/bored, wait/weight, break/brake. Elegí la opción que tenga sentido gramatical y " +
    "semántico en el contexto de la frase, no la que suene más común de forma aislada.",
  pt:
    "Portugués: prestá atención a los sonidos nasales y a la cedilla (ã, õ, ç), que el reconocimiento " +
    "de voz suele perder o simplificar. Pares que se confunden seguido: mas/mais, há/a, " +
    "seção/sessão/cessão, concerto/conserto, viagem/viajem.",
  fr:
    "Francés: por la cantidad de letras mudas y la \"liaison\" (enlace entre palabras al hablar), el " +
    "francés tiene muchísimos homófonos que dependen totalmente del contexto para desambiguar -- " +
    "ver/vert/verre/vers, sang/cent/sans/s'en, ou/où, ce/se, ces/ses/c'est/sais, mer/mère/maire. " +
    "Prestá atención también a los acentos (é/è/ê) y a la cedilla (ç), que cambian el significado.",
  it:
    "Italiano: las consonantes dobles cambian el significado de la palabra aunque el reconocimiento " +
    "de voz a veces no las distingue bien -- pena/penna, casa/cassa, sono/sonno, papa/pappa, " +
    "sera/serra. También pueden perderse los acentos en vocales finales (città, perché, però, " +
    "ventitré).",
  de:
    "Alemán: prestá especial atención a la diéresis (ä, ö, ü) y a la ß (Eszett) -- el reconocimiento de " +
    "voz muchas veces las reemplaza por la vocal simple o por \"ae\"/\"oe\"/\"ue\"/\"ss\", lo que cambia " +
    "el significado real de la palabra (ej: \"schon\" ≠ \"schön\", \"Strasse\" ≠ \"Straße\", \"fuer\" ≠ " +
    "\"für\", \"Bar\" ≠ \"Bär\"). El alemán también forma sustantivos compuestos largos uniendo varias " +
    "palabras sin espacio (ej: \"Lebensmittelgeschäft\"); el reconocimiento a veces los separa por error " +
    "en palabras sueltas sin sentido -- reconstruilos como una sola palabra compuesta cuando el contexto " +
    "lo sugiera. Los sustantivos en alemán siempre llevan mayúscula inicial. El alemán también tiene " +
    "muchos pares de palabras cortas que suenan muy parecido y se confunden fácil: por la pérdida de " +
    "sonoridad al final de palabra, \"Rad\" (rueda) puede sonar como \"Rat\" (consejo) y \"Bund\" como " +
    "\"bunt\" (colorido); por diferencias sutiles de duración vocálica, \"Stadt\" (ciudad) se confunde " +
    "con \"Staat\" (estado) y \"offen\" (abierto) con \"Ofen\" (horno); y palabras funcionales cortas " +
    "como \"und\"/\"an\", \"mit\"/\"mich\"/\"mir\", \"ist\"/\"isst\", \"war\"/\"wahr\" se confunden " +
    "seguido en habla rápida y fluida -- elegí la que tenga sentido gramatical en el resto de la " +
    "oración. El alemán además manda el verbo al final en oraciones subordinadas (ej: \"..., weil ich " +
    "das nicht verstanden habe\") -- no reordenes la oración a un orden más \"natural\" en otro idioma, " +
    "dejá el verbo donde corresponde en alemán aunque suene raro traducido literalmente.",
  zh:
    "Chino: escribí SIEMPRE en caracteres simplificados (简体字), nunca en tradicionales (繁體字), " +
    "sin importar qué haya usado el reconocimiento de voz o el texto de origen. El reconocimiento de " +
    "voz en chino se equivoca casi siempre por HOMÓFONOS -- muchos caracteres distintos suenan igual o " +
    "casi igual, a veces la única diferencia es el tono (ej: 是/十/时/使/世 se pronuncian todos \"shi\"; " +
    "在/再 ambos \"zai\"; 你/泥/逆 todos \"ni\"). Usá tu conocimiento del pinyin y qué carácter tiene " +
    "sentido semántico en el contexto para elegir el correcto -- no asumas que el primero que dio el " +
    "reconocimiento es el correcto solo por aparecer primero entre las alternativas. El chino no separa " +
    "las palabras con espacios: prestá atención a dónde probablemente empieza y termina cada palabra " +
    "dentro del fragmento antes de corregirlo o traducirlo.",
  ja:
    "Japonés: el idioma tiene muchísimos homófonos por la cantidad limitada de sonidos distintos, así " +
    "que un mismo sonido puede corresponder a varios kanji con significados totalmente distintos (ej: " +
    "橋/箸/端 se pronuncian todos \"hashi\"; 花/鼻 ambos \"hana\"; 神/紙/髪 todos \"kami\") -- elegí el " +
    "kanji según el sentido del contexto, no el más común en aislamiento. El japonés tampoco separa " +
    "las palabras con espacios: prestá atención a dónde probablemente empieza y termina cada palabra.",
};

function domainVocabLine(code: string): string | undefined {
  const short = shortLang(code);
  const words = DOMAIN_VOCAB[short];
  if (!words) return undefined;
  const name = SPANISH_LANGUAGE_NAMES[short] ?? short;
  return `Palabras de esta app en ${name} que aparecen seguido y son buenas candidatas cuando una ` +
    `lectura es ambigua: ${words}.`;
}

export function shortLang(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[shortLang(code)] ?? code;
}

// Returns the combined domain-vocabulary + linguistic-expertise notes for
// whichever of the given codes have one, deduped by short code, in a form
// ready to drop into a system prompt. Codes with no specific entry are
// silently skipped (nothing to add).
export function languageExpertiseHints(codes: string[]): string {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const code of codes) {
    const short = shortLang(code);
    if (seen.has(short)) continue;
    seen.add(short);
    const parts = [domainVocabLine(short), LANGUAGE_EXPERTISE[short]].filter(Boolean);
    if (parts.length) hints.push(parts.join(" "));
  }
  return hints.join("\n\n");
}

function cacheKey(text: string, source: string, target: string): string {
  return `${shortLang(source)}|${shortLang(target)}|${text}`;
}

async function translateWithClaude(text: string, from: string, to: string): Promise<string> {
  const sinOrigen = ORIGEN_DESCONOCIDO.has(from);
  const expertise = languageExpertiseHints(sinOrigen ? [to] : [from, to]);
  const system =
    (sinOrigen
      ? `Translate the user's message into ${languageName(to)}, detecting the source language yourself. `
      : `Translate the user's message from ${languageName(from)} to ${languageName(to)}. `) +
    `The message is a live-caption fragment from speech recognition and may contain misheard ` +
    `words; translate the meaning the speaker most likely intended, in natural, idiomatic ` +
    `${languageName(to)}. ` +
    `Reply with ONLY the translated text -- no quotes, no notes, no explanations.` +
    (expertise ? `\n\n${expertise}` : "");
  const response = await anthropicClient!.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: text }],
  });

  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  throw new Error("Claude no devolvió texto traducido");
}

async function translateWithMyMemory(text: string, from: string, to: string): Promise<string> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  // Su palabra clave de autodetección es "Autodetect", no "auto".
  url.searchParams.set("langpair", `${ORIGEN_DESCONOCIDO.has(from) ? "Autodetect" : from}|${to}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Translation provider responded with ${response.status}`);
  }

  const data = (await response.json()) as {
    responseData?: { translatedText?: string };
    responseStatus?: number | string;
  };

  // MyMemory contesta HTTP 200 hasta cuando falla: su estado real viene en el
  // JSON, y sus errores vienen como TEXTO adentro de translatedText. Sin
  // estas dos guardas, "'AUTO' IS AN INVALID SOURCE LANGUAGE" (o el cartel de
  // cuota agotada) aparecía EN PANTALLA como si fuera la traducción.
  if (data.responseStatus !== undefined && Number(data.responseStatus) !== 200) {
    throw new Error(`Translation provider status ${data.responseStatus}`);
  }

  const translated = data.responseData?.translatedText;
  if (!translated) {
    throw new Error("Translation provider returned no result");
  }
  if (/INVALID (SOURCE|TARGET) LANGUAGE|MYMEMORY WARNING|NO QUERY|QUERY LENGTH LIMIT/i.test(translated)) {
    throw new Error("Translation provider returned an error message instead of a translation");
  }
  return translated;
}

// "No sé en qué idioma está": el overlay de la extensión no siempre lo sabe.
// Cada proveedor tiene su forma de decirlo -- y NO es pasarle el literal
// "auto", que para MyMemory es "un idioma inválido".
const ORIGEN_DESCONOCIDO = new Set(["auto", "", "und"]);

export async function translateText(
  text: string,
  source: string,
  target: string
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const from = shortLang(source);
  const to = shortLang(target);
  if (from === to) return text;

  const key = cacheKey(trimmed, from, to);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const translated = anthropicEnabled
    ? await translateWithClaude(trimmed, from, to)
    : await translateWithMyMemory(trimmed, from, to);

  boundedCacheSet(key, translated);
  return translated;
}
