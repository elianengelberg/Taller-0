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
