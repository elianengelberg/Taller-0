import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import AccountMenu from "../components/AccountMenu";
import AiChatBox from "../components/AiChatBox";
import Button from "../components/Button";
import Logo from "../components/Logo";
import CalendarPanel from "../components/CalendarPanel";
import EmailVerificationNotice from "../components/EmailVerificationNotice";
import FolderShareDialog from "../components/FolderShareDialog";
import {
  askAllMeetingsAI,
  createFolderApi,
  deleteFolderApi,
  deleteMeetingApi,
  fetchFolderMeetings,
  fetchFolders,
  fetchMeetingsHistory,
  FolderSummary,
  MeetingHistorySummary,
  moveMeetingToFolderApi,
  renameFolderApi,
} from "../lib/api";
import { isExternalMeeting, meetingSourceLabel } from "../lib/meetingPlatforms";
import { MoreIcon, ShareIcon } from "../components/icons";
import { cardClass } from "../lib/ui";

// null = all; { kind:"none" } = loose (no folder); owned/shared folder id.
type Selection =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "owned"; folder: FolderSummary }
  | { kind: "shared"; folder: FolderSummary };

export default function History() {
  // Set when we got here from a login/registration whose guest-meeting claim
  // was rejected (see the notice below).
  const claimFailed = Boolean((useLocation().state as { claimFailed?: boolean } | null)?.claimFailed);
  const [meetings, setMeetings] = useState<MeetingHistorySummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [shared, setShared] = useState<FolderSummary[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  // Meetings of the currently selected SHARED folder (owned selections filter
  // the already-loaded `meetings` instead).
  const [sharedMeetings, setSharedMeetings] = useState<MeetingHistorySummary[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [shareDialog, setShareDialog] = useState<FolderSummary | null>(null);

  const reloadFolders = useCallback(async () => {
    const { folders, shared } = await fetchFolders();
    setFolders(folders);
    setShared(shared);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setMeetings(null);
    fetchMeetingsHistory()
      .then((data) => !cancelled && setMeetings(data))
      .catch(() => !cancelled && setError(true));
    reloadFolders();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, reloadFolders]);

  // Load a shared folder's meetings when it's selected.
  useEffect(() => {
    if (selection.kind !== "shared") {
      setSharedMeetings(null);
      return;
    }
    let cancelled = false;
    setSharedMeetings(null);
    fetchFolderMeetings(selection.folder.id).then((m) => !cancelled && setSharedMeetings(m));
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const visibleMeetings = useMemo(() => {
    if (selection.kind === "shared") return sharedMeetings;
    if (meetings === null) return null;
    if (selection.kind === "all") return meetings;
    if (selection.kind === "none") return meetings.filter((m) => !m.folderId);
    return meetings.filter((m) => m.folderId === selection.folder.id);
  }, [selection, meetings, sharedMeetings]);

  async function handleCreateFolder() {
    const name = window.prompt("Nombre de la carpeta nueva (ej: Ingeniería):")?.trim();
    if (!name) return;
    const { folder, error } = await createFolderApi(name);
    if (error) {
      window.alert(error);
      return;
    }
    if (folder) {
      setFolders((f) => [...f, folder].sort((a, b) => a.name.localeCompare(b.name)));
    }
  }

  async function handleRename(folder: FolderSummary) {
    const name = window.prompt("Nuevo nombre de la carpeta:", folder.name)?.trim();
    if (!name || name === folder.name) return;
    if (await renameFolderApi(folder.id, name)) {
      setFolders((f) => f.map((x) => (x.id === folder.id ? { ...x, name } : x)));
    }
  }

  async function handleDelete(folder: FolderSummary) {
    if (
      !window.confirm(
        `¿Eliminar la carpeta "${folder.name}"? Las reuniones que contiene NO se borran: vuelven a quedar sin carpeta.`
      )
    )
      return;
    if (await deleteFolderApi(folder.id)) {
      setFolders((f) => f.filter((x) => x.id !== folder.id));
      if (selection.kind === "owned" && selection.folder.id === folder.id)
        setSelection({ kind: "all" });
      setReloadKey((k) => k + 1); // refresh meeting folderIds
    }
  }

  async function handleMove(meetingId: string, folderId: string | null) {
    // Optimistic update of the loaded list.
    setMeetings((ms) =>
      ms ? ms.map((m) => (m.id === meetingId ? { ...m, folderId } : m)) : ms
    );
    await moveMeetingToFolderApi(meetingId, folderId);
    reloadFolders(); // update counts
  }

  async function handleDeleteMeeting(meetingId: string) {
    // Optimistic removal; put it back if the server rejects.
    const prev = meetings;
    setMeetings((ms) => (ms ? ms.filter((m) => m.id !== meetingId) : ms));
    const ok = await deleteMeetingApi(meetingId);
    if (!ok) {
      setMeetings(prev);
      window.alert("No se pudo eliminar la reunión.");
    } else {
      reloadFolders();
    }
  }

  return (
    <div className="min-h-screen bg-ink-950 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Logo />
          <div className="flex min-w-0 items-center gap-3 sm:gap-6">
            <Link to="/" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong">
              Volver al inicio
            </Link>
            <AccountMenu />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-strong">Historial de reuniones</h1>
        <p className="mt-1 text-sm text-ink-400">
          Reuniones guardadas con su chat, transcripción, grabación e informe. Organizalas en
          carpetas y compartilas.
        </p>

        {/* Mientras el email no esté confirmado, la cuenta no se puede
            recuperar. Va acá arriba porque el historial es justamente lo que
            se pierde si eso pasa. */}
        <EmailVerificationNotice className="mt-4" />

        {/* Honest notice when a guest's meeting couldn't be attached to this
            account (it already belongs to whoever opened that room logged in).
            Saying nothing would look like the meeting silently disappeared. */}
        {claimFailed && (
          <div className="mt-4 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-3 text-sm text-brand-200">
            Esa reunión ya está guardada en la cuenta de quien la abrió, así que no pudimos sumarla
            a la tuya. Pedile que te comparta la carpeta donde la tenga y la vas a ver acá.
          </div>
        )}

        <CalendarPanel />

        {!error && meetings !== null && meetings.length > 0 && (
          <AiChatBox
            className="mt-6"
            title="Preguntale a la IA sobre tus reuniones"
            description="Busca en todo tu historial, no solo en una reunión puntual — preguntale por fecha, por quién participó o por lo que se habló."
            placeholder='Ej: "¿qué se habló en mi última reunión?" o "¿tuve una reunión el 17 de junio?"'
            emptyHint="Esta IA busca en todas tus reuniones guardadas a la vez."
            onAsk={askAllMeetingsAI}
          />
        )}

        <div className="mt-8 grid gap-6 md:grid-cols-[220px_1fr]">
          {/* Folder rail */}
          <aside className="space-y-1">
            <FolderButton
              label="Todas"
              active={selection.kind === "all"}
              onClick={() => setSelection({ kind: "all" })}
            />
            <FolderButton
              label="Sin carpeta"
              active={selection.kind === "none"}
              onClick={() => setSelection({ kind: "none" })}
            />

            <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Carpetas
            </p>
            {folders.map((f) => (
              <FolderButton
                key={f.id}
                label={f.name}
                count={f.meetingCount}
                shared={Boolean(f.sharedWithCount)}
                active={selection.kind === "owned" && selection.folder.id === f.id}
                onClick={() => setSelection({ kind: "owned", folder: f })}
                menu={[
                  { label: "Compartir", onClick: () => setShareDialog(f) },
                  { label: "Renombrar", onClick: () => handleRename(f) },
                  { label: "Eliminar", onClick: () => handleDelete(f), danger: true },
                ]}
              />
            ))}
            <button
              type="button"
              onClick={handleCreateFolder}
              className="mt-1 w-full rounded-lg px-2 py-2 text-left text-sm font-medium text-brand-300 hover:bg-ink-800"
            >
              + Nueva carpeta
            </button>

            {shared.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                  Compartidas conmigo
                </p>
                {shared.map((f) => (
                  <FolderButton
                    key={f.id}
                    label={f.name}
                    count={f.meetingCount}
                    sublabel={f.ownerName ? `de ${f.ownerName}` : undefined}
                    active={selection.kind === "shared" && selection.folder.id === f.id}
                    onClick={() => setSelection({ kind: "shared", folder: f })}
                  />
                ))}
              </>
            )}
          </aside>

          {/* Meeting list */}
          <div className="space-y-3">
            {error && (
              <div className={`${cardClass} space-y-3`}>
                <p className="text-sm text-brand-300">
                  No pudimos conectar con el servidor. Si hace rato que no se usa la app, puede
                  estar "despertando" (tarda hasta un minuto la primera vez).
                </p>
                <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                  Reintentar
                </Button>
              </div>
            )}
            {!error && visibleMeetings === null && (
              <p className={`${cardClass} text-sm text-ink-400`}>Cargando…</p>
            )}
            {!error && visibleMeetings !== null && visibleMeetings.length === 0 && (
              <p className={`${cardClass} text-sm text-ink-400`}>
                {selection.kind === "all"
                  ? "Todavía no hay reuniones guardadas. Si el servidor no tiene una base de datos configurada, el historial no está disponible."
                  : "No hay reuniones en esta carpeta."}
              </p>
            )}
            {!error &&
              visibleMeetings?.map((m) => (
                <MeetingCard
                  key={m.id}
                  meeting={m}
                  folders={folders}
                  owned={selection.kind !== "shared"}
                  onMove={handleMove}
                  onDelete={handleDeleteMeeting}
                />
              ))}
          </div>
        </div>
      </div>

      {shareDialog && (
        <FolderShareDialog
          folder={shareDialog}
          onClose={() => {
            setShareDialog(null);
            reloadFolders();
          }}
        />
      )}
    </div>
  );
}

function FolderButton({
  label,
  sublabel,
  count,
  shared,
  active,
  onClick,
  menu,
}: {
  label: string;
  sublabel?: string;
  count?: number;
  shared?: boolean;
  active: boolean;
  onClick: () => void;
  menu?: { label: string; onClick: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
          active ? "bg-brand-500/15 text-brand-200" : "text-ink-200 hover:bg-ink-800"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">
          {label}
          {sublabel && <span className="ml-1 text-xs text-ink-500">· {sublabel}</span>}
        </span>
        {shared && <ShareIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" />}
        {typeof count === "number" && <span className="shrink-0 text-xs text-ink-500">{count}</span>}
      </button>
      {menu && (
        <div className="relative">
          <button
            type="button"
            aria-label={`Acciones de la carpeta ${label}`}
            onClick={() => setOpen((o) => !o)}
            className="rounded-full p-1 text-ink-400 opacity-0 hover:bg-ink-700 hover:text-strong group-hover:opacity-100 aria-expanded:opacity-100"
            aria-expanded={open}
          >
            <MoreIcon className="h-4 w-4" />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
              <div className="absolute right-0 z-30 mt-1 w-40 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 py-1 shadow-soft">
                {menu.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      item.onClick();
                    }}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-ink-700 ${
                      item.danger ? "text-red-400" : "text-ink-100"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MeetingCard({
  meeting: m,
  folders,
  owned,
  onMove,
  onDelete,
}: {
  meeting: MeetingHistorySummary;
  folders: FolderSummary[];
  owned: boolean;
  onMove: (meetingId: string, folderId: string | null) => void;
  onDelete: (meetingId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [movePane, setMovePane] = useState(false);
  const close = () => {
    setOpen(false);
    setMovePane(false);
  };
  return (
    <div className={`${cardClass} transition hover:border-brand-400`}>
      <div className="flex items-start justify-between gap-3">
        <Link to={`/historial/${m.id}`} className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-semibold text-strong">Reunión de {m.hostName}</p>
            <SourceChip joinCode={m.joinCode} />
            {m.hasReport && (
              <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] font-medium text-brand-300">
                Con informe
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-400">
            {new Date(m.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            {" · "}
            {m.participants.length} participante{m.participants.length === 1 ? "" : "s"}
            {" · "}
            {m.messageCount} mensaje{m.messageCount === 1 ? "" : "s"}
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {m.recordingUrl && (
            <span className="rounded-full bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-300">
              Con video
            </span>
          )}
          {owned && (
            <div className="relative">
              <button
                type="button"
                aria-label={`Opciones de la reunión de ${m.hostName}`}
                aria-expanded={open}
                onClick={() => (open ? close() : setOpen(true))}
                className="rounded-full p-1.5 text-ink-400 transition-colors hover:bg-ink-700 hover:text-strong"
              >
                <MoreIcon className="h-4 w-4" />
              </button>
              {open && (
                <>
                  <div className="fixed inset-0 z-20" onClick={close} />
                  <div className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 py-1 shadow-soft">
                    {!movePane ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setMovePane(true)}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ink-100 hover:bg-ink-700"
                        >
                          Mover a carpeta
                          <span className="text-ink-500">›</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                `¿Eliminar esta reunión de ${m.hostName}? Se borran su transcripción, chat, informe y grabación. No se puede deshacer.`
                              )
                            ) {
                              close();
                              onDelete(m.id);
                            }
                          }}
                          className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-ink-700"
                        >
                          Eliminar
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setMovePane(false)}
                          className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-medium text-ink-400 hover:bg-ink-700"
                        >
                          ‹ Volver
                        </button>
                        <div className="max-h-56 overflow-y-auto">
                          <button
                            type="button"
                            onClick={() => {
                              onMove(m.id, null);
                              close();
                            }}
                            className={`block w-full px-3 py-2 text-left text-sm hover:bg-ink-700 ${
                              !m.folderId ? "text-brand-300" : "text-ink-100"
                            }`}
                          >
                            Sin carpeta {!m.folderId && "✓"}
                          </button>
                          {folders.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              onClick={() => {
                                onMove(m.id, f.id);
                                close();
                              }}
                              className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-ink-700 ${
                                m.folderId === f.id ? "text-brand-300" : "text-ink-100"
                              }`}
                            >
                              {f.name} {m.folderId === f.id && "✓"}
                            </button>
                          ))}
                          {folders.length === 0 && (
                            <p className="px-3 py-2 text-xs text-ink-500">
                              No tenés carpetas todavía. Creá una con "+ Nueva carpeta".
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceChip({ joinCode }: { joinCode: string }) {
  const external = isExternalMeeting(joinCode);
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        external ? "bg-brand-500/15 text-brand-300" : "bg-ink-700/70 text-ink-300"
      }`}
    >
      {meetingSourceLabel(joinCode)}
    </span>
  );
}
