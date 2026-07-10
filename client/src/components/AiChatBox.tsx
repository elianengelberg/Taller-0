import { FormEvent, useState } from "react";
import { cardClass, inputClass } from "../lib/ui";
import Button from "./Button";
import { SparklesIcon } from "./icons";
import MarkdownText from "./MarkdownText";

interface QA {
  question: string;
  answer?: string;
  error?: string;
  loading: boolean;
}

interface Props {
  title: string;
  description: string;
  placeholder: string;
  emptyHint?: string;
  onAsk: (question: string) => Promise<{ answer?: string; error?: string }>;
  className?: string;
}

export default function AiChatBox({ title, description, placeholder, emptyHint, onAsk, className }: Props) {
  const [question, setQuestion] = useState("");
  const [items, setItems] = useState<QA[]>([]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    setItems((prev) => [...prev, { question: q, loading: true }]);
    const result = await onAsk(q);
    setItems((prev) =>
      prev.map((item, index) =>
        index === prev.length - 1
          ? { ...item, loading: false, answer: result.answer, error: result.error }
          : item
      )
    );
  }

  return (
    <div className={`${cardClass} ${className ?? ""}`}>
      <div className="mb-3 flex items-center gap-2">
        <SparklesIcon className="h-5 w-5 text-brand-400" />
        <h2 className="text-lg font-semibold text-strong">{title}</h2>
      </div>
      <p className="mb-3 text-xs text-ink-400">{description}</p>

      {items.length === 0 && emptyHint && <p className="mb-3 text-xs text-ink-500">{emptyHint}</p>}

      {items.length > 0 && (
        <ul className="mb-3 space-y-3">
          {items.map((item, index) => (
            <li key={index} className="rounded-xl border border-ink-700 bg-ink-800/60 p-3">
              <p className="text-sm font-semibold text-strong">{item.question}</p>
              {item.loading ? (
                <p className="mt-1 text-sm text-ink-400">Pensando…</p>
              ) : item.error ? (
                <p className="mt-1 text-sm text-red-400">{item.error}</p>
              ) : (
                <div className="mt-2">
                  <MarkdownText text={item.answer ?? ""} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          className={`${inputClass} py-2.5 text-sm`}
          placeholder={placeholder}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
        />
        <Button type="submit" className="px-4 py-2.5 text-sm" disabled={!question.trim()}>
          Preguntar
        </Button>
      </form>
    </div>
  );
}
