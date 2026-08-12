import Markdown, { Components } from "react-markdown";

// Tailwind's preflight strips default spacing from every element, so
// rendering markdown with no overrides collapses everything onto cramped,
// touching lines. These give paragraphs/lists/headings breathing room and
// match the app's dark theme instead of pulling in the Typography plugin.
const components: Components = {
  p: ({ children }) => <p className="mb-2.5 text-sm leading-relaxed text-ink-100 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-strong">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="mb-2.5 ml-4 list-disc space-y-1 text-sm leading-relaxed text-ink-100 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2.5 ml-4 list-decimal space-y-1 text-sm leading-relaxed text-ink-100 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => <h3 className="mb-1.5 mt-3 text-base font-bold text-strong first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1.5 mt-3 text-base font-bold text-strong first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-bold text-strong first:mt-0">{children}</h3>,
  code: ({ children }) => <code className="rounded bg-ink-900 px-1 py-0.5 text-xs text-brand-200">{children}</code>,
  a: ({ href, children }) => {
    const safe = safeHref(href);
    // Sin destino seguro no se renderiza un enlace: queda el texto, visible
    // pero inofensivo. Mejor que un enlace muerto que igual invita a hacer clic.
    if (!safe) return <span className="text-ink-100">{children}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        // noopener además de noreferrer: sin él, la página que se abre puede
        // redirigir la nuestra desde window.opener (tabnabbing).
        rel="noopener noreferrer"
        className="text-brand-300 underline hover:text-brand-200"
      >
        {children}
      </a>
    );
  },
};

// Sólo enlaces web o de correo.
//
// Esto se usa para mostrar respuestas de la IA, y la IA lee la transcripción de
// la reunión: alcanza con que un participante diga la frase indicada para que
// la respuesta salga con un enlace `javascript:` (inyección de prompt). React
// no filtra el href, así que lo renderizaría tal cual y un clic de OTRA persona
// ejecutaría ese código con su sesión abierta -- incluido leerle el token.
function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  // Un enlace relativo o de ancla no lleva esquema y no puede ejecutar nada.
  if (/^[/#?]/.test(value)) return value;
  try {
    const scheme = new URL(value, window.location.origin).protocol;
    return scheme === "http:" || scheme === "https:" || scheme === "mailto:" ? value : null;
  } catch {
    return null;
  }
}

export default function MarkdownText({ text }: { text: string }) {
  return <Markdown components={components}>{text}</Markdown>;
}
