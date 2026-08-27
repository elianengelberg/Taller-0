export interface LanguageOption {
  code: string;
  label: string;
}

// Codes double as BCP-47 tags for the Web Speech API and, once shortened to
// their two-letter prefix, as MyMemory translation language codes.
export const LANGUAGES: LanguageOption[] = [
  { code: "es-AR", label: "Español (Argentina)" },
  { code: "es-ES", label: "Español (España)" },
  { code: "es-MX", label: "Español (México)" },
  { code: "en-US", label: "Inglés (EE. UU.)" },
  { code: "en-GB", label: "Inglés (Reino Unido)" },
  { code: "pt-BR", label: "Portugués (Brasil)" },
  { code: "fr-FR", label: "Francés" },
  { code: "it-IT", label: "Italiano" },
  { code: "de-DE", label: "Alemán" },
  { code: "zh-CN", label: "Chino (simplificado)" },
  { code: "ja-JP", label: "Japonés" },
];

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function shortLang(code: string): string {
  return code.split("-")[0]?.toLowerCase() ?? code;
}

// El idioma "de fábrica" de los selectores: el que la persona ELIGIÓ la
// última vez (recordado entre visitas) o, la primera vez, el del propio
// dispositivo. Así "hablo en..." y el "Automático" de la traducción apuntan
// a tu idioma sin configurar nada, en cualquier aparato.
export function idiomaDelDispositivo(): string {
  try {
    const guardado = localStorage.getItem("unify_lang");
    if (guardado && LANGUAGES.some((l) => l.code === guardado)) return guardado;
  } catch {
    /* modo privado: sin memoria, se sigue con el del aparato */
  }
  const candidatos = (
    navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
  ).filter(Boolean);
  for (const cand of candidatos) {
    const exacto = LANGUAGES.find((l) => l.code.toLowerCase() === cand.toLowerCase());
    if (exacto) return exacto.code;
  }
  // Sin coincidencia exacta, vale la familia: un dispositivo en "es" (o
  // es-CL, es-PE...) cae al primer español de la lista.
  for (const cand of candidatos) {
    const base = cand.split("-")[0].toLowerCase();
    const porFamilia = LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base));
    if (porFamilia) return porFamilia.code;
  }
  return LANGUAGES[0].code;
}

export function recordarIdioma(code: string): void {
  try {
    localStorage.setItem("unify_lang", code);
  } catch {
    /* modo privado: no se recuerda, nada más */
  }
}

export function etiquetaDeIdioma(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
