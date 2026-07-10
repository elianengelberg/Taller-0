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
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand-300 underline hover:text-brand-200">
      {children}
    </a>
  ),
};

export default function MarkdownText({ text }: { text: string }) {
  return <Markdown components={components}>{text}</Markdown>;
}
