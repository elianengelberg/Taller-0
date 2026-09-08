// Copia GENERADA por client/scripts/sync-compartido.mjs desde client/src/lib/idioma.ts: no editar acá.
// DETECTAR EL IDIOMA DE UNA FRASE sin pedirle nada a nadie. Sirve para no
// creerle a la etiqueta: el reconocimiento etiqueta cada línea con el idioma
// que se le CONFIGURÓ (el tuyo), y cuando alguien te habla en inglés la línea
// llega marcada "es-AR" -- y toda la cadena la daba por traducida. Con esto,
// una frase en inglés marcada como español se traduce igual.
//
// Cómo: primero la escritura (kanji/kana, hangul, cirílico, árabe, hebreo,
// tailandés no dejan dudas); después, palabras funcionales de seis idiomas
// (es, en, pt, fr, it, de), que son las que más se repiten al hablar. Devuelve
// el código corto ("en") o null cuando no está seguro: la duda se resuelve
// creyéndole a la etiqueta, nunca adivinando.
//
// La MISMA tabla vive en server/src/idioma.ts y extension/idioma.js: cambiar
// una es cambiar las tres (pruebas/sim_idioma.ts las compara).
const PALABRAS = {
    es: ["el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "es", "no", "con", "por", "para", "se", "lo", "al", "como", "pero", "más", "muy", "ya", "hay", "este", "esta", "eso", "esto", "qué", "también", "porque", "cuando", "entonces", "nosotros", "ustedes", "usted", "sí", "bien", "hola", "gracias", "tenemos", "vamos", "ahora", "está", "son", "todo", "nada", "mañana", "reunión", "bueno", "dale", "vos", "tenés", "podés", "tenes", "podes", "querés", "queres", "podemos", "tengo", "quiero", "puede", "hacer", "mandar", "ver", "decir", "me", "te", "mi", "tu", "le", "les", "su", "sus", "ese", "esa", "ni"],
    en: ["the", "and", "to", "of", "a", "in", "is", "it", "you", "that", "for", "on", "with", "are", "this", "we", "be", "have", "not", "at", "can", "will", "was", "from", "they", "what", "about", "so", "just", "okay", "ok", "yeah", "let's", "going", "i'm", "don't", "think", "know", "right", "need", "time", "next", "meeting", "i", "my", "your", "our", "if", "do", "get", "here", "there", "please", "thanks", "hello", "hi", "good", "all", "but", "or", "want", "make", "see", "say", "send", "call", "me", "he", "she", "his", "her", "them", "us", "no", "yes", "very", "some", "how", "when", "where"],
    pt: ["o", "a", "os", "as", "de", "do", "da", "dos", "das", "que", "e", "em", "um", "uma", "é", "não", "com", "por", "para", "se", "no", "na", "como", "mas", "mais", "muito", "já", "também", "porque", "quando", "então", "nós", "vocês", "você", "sim", "bem", "olá", "obrigado", "obrigada", "temos", "vamos", "agora", "está", "isso", "tudo", "nada", "amanhã", "reunião", "bom", "gente", "pode", "tenho", "quero", "fazer", "ver", "dizer", "me", "te", "meu", "minha", "seu", "sua", "esse", "essa", "nem"],
    fr: ["le", "la", "les", "des", "du", "de", "et", "à", "un", "une", "est", "pas", "ne", "que", "qui", "en", "dans", "pour", "sur", "avec", "ce", "cette", "nous", "vous", "je", "il", "elle", "ils", "sont", "mais", "aussi", "très", "bien", "oui", "bonjour", "merci", "alors", "maintenant", "c'est", "tout", "demain", "réunion", "on", "ça", "d'accord"],
    it: ["il", "lo", "la", "gli", "le", "di", "del", "della", "che", "e", "è", "non", "con", "per", "un", "una", "in", "sono", "ma", "anche", "molto", "già", "come", "questo", "questa", "noi", "voi", "sì", "bene", "ciao", "grazie", "allora", "adesso", "abbiamo", "andiamo", "tutto", "domani", "riunione", "va", "cosa"],
    de: ["der", "die", "das", "und", "ist", "nicht", "ich", "wir", "sie", "es", "ein", "eine", "zu", "mit", "auf", "für", "von", "den", "dem", "auch", "sehr", "schon", "aber", "wenn", "dann", "jetzt", "haben", "sind", "wird", "ja", "gut", "hallo", "danke", "bitte", "alles", "morgen", "besprechung", "wie", "was"],
};
// Palabras que aparecen en varias listas suman menos: "de" o "la" no
// distinguen español de portugués, "a" ni siquiera de inglés.
const FRECUENCIA = {};
for (const lista of Object.values(PALABRAS)) {
    for (const p of new Set(lista))
        FRECUENCIA[p] = (FRECUENCIA[p] || 0) + 1;
}
function porEscritura(texto) {
    if (/[぀-ヿ]/.test(texto))
        return "ja"; // hiragana / katakana
    if (/[一-鿿]/.test(texto))
        return "zh"; // han (sin kana: chino)
    if (/[가-힯]/.test(texto))
        return "ko";
    if (/[Ѐ-ӿ]/.test(texto))
        return "ru";
    if (/[؀-ۿ]/.test(texto))
        return "ar";
    if (/[֐-׿]/.test(texto))
        return "he";
    if (/[฀-๿]/.test(texto))
        return "th";
    return null;
}
function detectarIdioma(texto) {
    const t = String(texto || "").trim();
    if (!t)
        return null;
    const escritura = porEscritura(t);
    if (escritura)
        return escritura;
    const palabras = t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}'’\s]/gu, " ")
        .replace(/’/g, "'")
        .split(/\s+/)
        .filter(Boolean);
    if (palabras.length < 3)
        return null;
    const puntos = {};
    for (const idioma of Object.keys(PALABRAS))
        puntos[idioma] = 0;
    const conjuntos = {};
    for (const [idioma, lista] of Object.entries(PALABRAS))
        conjuntos[idioma] = new Set(lista);
    for (const p of palabras) {
        const peso = 1 / (FRECUENCIA[p] || 1);
        for (const idioma of Object.keys(conjuntos))
            if (conjuntos[idioma].has(p))
                puntos[idioma] += peso;
    }
    const orden = Object.entries(puntos).sort((a, b) => b[1] - a[1]);
    const [mejor, segundo] = orden;
    // Seguro = al menos dos "pistas enteras", una de ventaja clara sobre el
    // siguiente, y no menos de un quinto de las palabras apuntando ahí.
    if (mejor[1] < 2 || mejor[1] - segundo[1] < 1 || mejor[1] < palabras.length * 0.2)
        return null;
    return mejor[0];
}
// El idioma EFECTIVO de una línea: el detectado cuando contradice con
// seguridad a la etiqueta; si no, la etiqueta (en dos letras).
function idiomaEfectivo(texto, etiqueta) {
    const corto = String(etiqueta || "").split("-")[0].toLowerCase();
    const detectado = detectarIdioma(texto);
    return detectado && detectado !== corto ? detectado : corto;
}
function crearMemoriaDeIdioma(opciones = {}) {
    const vidaMs = opciones.vidaMs ?? 30 * 60000;
    const maxClaves = opciones.maxClaves ?? 500;
    const visto = new Map();
    function anotar(clave, idioma) {
        if (!clave || !idioma)
            return;
        // Reinsertar mueve la clave al final: al podar se van las más viejas.
        visto.delete(clave);
        visto.set(clave, { idioma, at: Date.now() });
        while (visto.size > maxClaves) {
            const primera = visto.keys().next();
            if (primera.done)
                break;
            visto.delete(primera.value);
        }
    }
    function recordar(clave) {
        const dato = visto.get(clave);
        if (!dato)
            return null;
        if (Date.now() - dato.at > vidaMs) {
            visto.delete(clave);
            return null;
        }
        return dato.idioma;
    }
    function resolver(claves, texto, etiqueta) {
        const lista = (Array.isArray(claves) ? claves : [claves]).filter(Boolean);
        const corto = String(etiqueta || "").split("-")[0].toLowerCase();
        const detectado = detectarIdioma(texto);
        if (detectado) {
            for (const clave of lista)
                anotar(clave, detectado);
            return detectado;
        }
        for (const clave of lista) {
            const recordado = recordar(clave);
            if (recordado)
                return recordado;
        }
        return corto;
    }
    return { anotar, recordar, resolver };
}

// Un content script no tiene módulos: se cuelga de window para content.js y
// prompt-injector.js (que corren después, ver manifest.json).
window.__unifyIdioma = { detectarIdioma, idiomaEfectivo, crearMemoriaDeIdioma };
