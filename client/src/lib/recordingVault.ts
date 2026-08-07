// Bóveda de rescate para grabaciones.
//
// Problema real que resuelve: la grabación terminada vive en memoria como un
// Blob y se sube en un `fetch`. Si la subida falla (servidor dormido, red
// caída, R2 sin CORS) o si la persona cierra la pestaña mientras sube, el
// archivo se pierde para siempre: no quedó en el historial ni en el disco.
//
// Acá la guardamos en IndexedDB ANTES de intentar subirla y la borramos recién
// cuando el servidor confirma. Al volver a abrir Unify, lo que haya quedado se
// reintenta solo. IndexedDB (no localStorage) porque un video son decenas o
// cientos de MB y localStorage sólo guarda strings de unos pocos MB.

const DB_NAME = "unify-recordings";
const STORE = "pending";
const DB_VERSION = 1;
// Más viejo que esto ya no se reintenta: la reunión hace rato que pasó y el
// archivo sólo estaría ocupando la cuota del navegador.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingRecording {
  id: string;
  meetingDbId: string;
  blob: Blob;
  contentType: string;
  durationMs: number;
  savedAt: number;
  attempts: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Modo privado de Safari, cuota llena, o el usuario bloqueó el
    // almacenamiento: seguimos sin bóveda en vez de romper la grabación.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Guarda la grabación antes de intentar subirla. Devuelve su id, o null. */
export async function stashRecording(
  entry: Omit<PendingRecording, "id" | "savedAt" | "attempts">
): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  const id = `${entry.meetingDbId}:${Date.now()}`;
  const ok = await tx(db, "readwrite", (s) =>
    s.put({ ...entry, id, savedAt: Date.now(), attempts: 0 } satisfies PendingRecording)
  );
  db.close();
  return ok === null ? null : id;
}

export async function dropRecording(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, "readwrite", (s) => s.delete(id));
  db.close();
}

/** Las que quedaron sin subir, ya sin las vencidas (que además se borran). */
export async function listPendingRecordings(): Promise<PendingRecording[]> {
  const db = await openDb();
  if (!db) return [];
  const all = (await tx<PendingRecording[]>(db, "readonly", (s) => s.getAll())) ?? [];
  const fresh: PendingRecording[] = [];
  for (const rec of all) {
    if (Date.now() - rec.savedAt > MAX_AGE_MS) await tx(db, "readwrite", (s) => s.delete(rec.id));
    else fresh.push(rec);
  }
  db.close();
  return fresh;
}

export async function markAttempt(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const rec = await tx<PendingRecording>(db, "readonly", (s) => s.get(id));
  if (rec) await tx(db, "readwrite", (s) => s.put({ ...rec, attempts: rec.attempts + 1 }));
  db.close();
}
