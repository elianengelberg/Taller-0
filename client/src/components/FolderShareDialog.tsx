import { FormEvent, useEffect, useState } from "react";
import {
  fetchFolderShares,
  FolderShareRecipient,
  FolderSummary,
  shareFolderApi,
  unshareFolderApi,
} from "../lib/api";
import { CloseIcon } from "./icons";

// Share a whole folder (read-only) with another Unify account by email. The
// recipient then sees every meeting inside it under "Compartidas conmigo".
export default function FolderShareDialog({
  folder,
  onClose,
}: {
  folder: FolderSummary;
  onClose: () => void;
}) {
  const [recipients, setRecipients] = useState<FolderShareRecipient[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchFolderShares(folder.id).then(setRecipients);
  }, [folder.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) return;
    setBusy(true);
    setError(null);
    const res = await shareFolderApi(folder.id, value);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setEmail("");
    setRecipients(await fetchFolderShares(folder.id));
  }

  async function remove(userId: string) {
    if (await unshareFolderApi(folder.id, userId)) {
      setRecipients((r) => r.filter((x) => x.userId !== userId));
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-top"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-strong">Compartir "{folder.name}"</h2>
            <p className="mt-0.5 text-sm text-ink-400">
              La persona podrá ver todas las reuniones de esta carpeta (solo lectura).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-full p-1 text-ink-400 hover:bg-ink-700 hover:text-strong"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4 flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@ejemplo.com"
            aria-label="Email de la persona"
            className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-strong focus:border-brand-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? "…" : "Compartir"}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-brand-300">{error}</p>}

        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Compartida con
          </p>
          {recipients.length === 0 ? (
            <p className="text-sm text-ink-400">Todavía no la compartiste con nadie.</p>
          ) : (
            <ul className="space-y-1.5">
              {recipients.map((r) => (
                <li
                  key={r.userId}
                  className="flex items-center justify-between gap-2 rounded-lg bg-ink-800/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-strong">{r.name}</p>
                    <p className="truncate text-xs text-ink-400">{r.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(r.userId)}
                    className="shrink-0 text-xs font-medium text-red-400 hover:text-red-300"
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
