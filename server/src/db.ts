import { randomUUID } from "crypto";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const isLocal = !!DATABASE_URL && /localhost|127\.0\.0\.1/.test(DATABASE_URL);

export const dbEnabled = Boolean(DATABASE_URL);

// TLS to the database: by default the connection is encrypted but the
// server's certificate is NOT verified (rejectUnauthorized: false) -- that's
// what most Render/Neon quickstarts assume and what this app has always run
// with. Setting DATABASE_SSL_STRICT=1 turns on full certificate
// verification (works out of the box with Neon, whose certs chain to a
// public CA). If queries start failing with a certificate error after
// enabling it, remove the flag and the previous behavior returns.
const sslConfig = isLocal
  ? undefined
  : process.env.DATABASE_SSL_STRICT === "1"
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false };

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslConfig,
    })
  : null;

let migration: Promise<void> | null = null;

function migrate(): Promise<void> {
  if (!pool) return Promise.resolve();
  if (!migration) {
    migration = pool
      .query(
        `CREATE TABLE IF NOT EXISTS meetings (
          id UUID PRIMARY KEY,
          join_code TEXT NOT NULL,
          host_name TEXT NOT NULL,
          roles JSONB NOT NULL DEFAULT '[]',
          participants JSONB NOT NULL DEFAULT '[]',
          recording_url TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          ended_at TIMESTAMPTZ
        );`
      )
      .then(() =>
        pool.query(
          `CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            role_name TEXT,
            text TEXT NOT NULL,
            source_lang TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );`
        )
      )
      .then(() =>
        pool.query(`CREATE INDEX IF NOT EXISTS messages_meeting_id_idx ON messages(meeting_id);`)
      )
      // Accounts: each person's meeting history is private to them.
      .then(() =>
        pool.query(
          `CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );`
        )
      )
      // owner_id ties a meeting to the account that created it (nullable:
      // meetings created by a guest, or before accounts existed, have none).
      .then(() => pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS owner_id UUID;`))
      .then(() =>
        pool.query(`CREATE INDEX IF NOT EXISTS meetings_owner_id_idx ON meetings(owner_id);`)
      )
      // Google Sign-In: an account created via Google never has a password
      // (password_hash NULL means "log in with Google only"), and google_id
      // is how a returning Google login is matched back to its account.
      .then(() => pool.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`))
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;`))
      // Outlook/Microsoft calendar: the long-lived refresh token so we can
      // fetch the person's upcoming meetings on their behalf. NULL until they
      // connect their calendar; cleared when they disconnect.
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_refresh_token TEXT;`))
      // Folders: organize a person's saved meetings ("Ingeniería", "Clientes"…).
      .then(() =>
        pool.query(
          `CREATE TABLE IF NOT EXISTS folders (
            id UUID PRIMARY KEY,
            owner_id UUID NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );`
        )
      )
      .then(() =>
        pool.query(`CREATE INDEX IF NOT EXISTS folders_owner_id_idx ON folders(owner_id);`)
      )
      // A meeting lives in at most one folder (NULL = loose in the history).
      .then(() => pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS folder_id UUID;`))
      .then(() =>
        pool.query(`CREATE INDEX IF NOT EXISTS meetings_folder_id_idx ON meetings(folder_id);`)
      )
      // Sharing a whole folder with another account (read-only access to
      // every meeting inside it). One row per (folder, recipient).
      .then(() =>
        pool.query(
          `CREATE TABLE IF NOT EXISTS folder_shares (
            folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            shared_with_user_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (folder_id, shared_with_user_id)
          );`
        )
      )
      .then(() =>
        pool.query(
          `CREATE INDEX IF NOT EXISTS folder_shares_user_idx ON folder_shares(shared_with_user_id);`
        )
      )
      // Saved AI report per meeting (generated once, then persisted so it
      // doesn't cost a model call every time the meeting is opened).
      .then(() => pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report TEXT;`))
      .then(() =>
        pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS report_generated_at TIMESTAMPTZ;`)
      )
      // When the recording started (server clock), so the history player can
      // line the transcript up with the video's timeline (t=0 = this moment).
      .then(() =>
        pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recording_started_at TIMESTAMPTZ;`)
      )
      .then(() => undefined)
      .catch((err) => {
        console.error("No se pudo preparar la base de datos:", err.message);
      });
  }
  return migration;
}

if (pool) {
  migrate();
}

export interface PersistedUser {
  id: string;
  email: string;
  name: string;
}

// passwordHash is null for accounts created via Google Sign-In that never
// set a password -- callers must check before handing it to verifyPassword.
type UserAuthRow = PersistedUser & { passwordHash: string | null; googleId: string | null };

export interface PersistedRole {
  id: string;
  name: string;
  colorIndex: number;
}

export interface PersistedParticipant {
  id: string;
  name: string;
  roleId: string | null;
  isHost: boolean;
}

export interface PersistedMessage {
  id: number;
  kind: "chat" | "transcript";
  senderName: string;
  roleName: string | null;
  text: string;
  sourceLang: string | null;
  createdAt: string;
}

export interface MeetingSummary {
  id: string;
  joinCode: string;
  hostName: string;
  participants: PersistedParticipant[];
  recordingUrl: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  folderId: string | null;
  hasReport: boolean;
}

export interface MeetingDetail extends MeetingSummary {
  roles: PersistedRole[];
  messages: PersistedMessage[];
  report: string | null;
  reportGeneratedAt: string | null;
  recordingStartedAt: string | null;
  // True when the viewer is not the owner but reached this meeting through a
  // folder shared with them -- the UI uses it to present a read-only view.
  sharedView?: boolean;
}

export interface FolderSummary {
  id: string;
  name: string;
  createdAt: string;
  meetingCount: number;
  // Present only for folders shared WITH the current user (who owns them).
  ownerName?: string;
  sharedWithCount?: number;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!pool) return fallback;
  try {
    await migrate();
    return await fn();
  } catch (err) {
    console.error("Error de base de datos:", (err as Error).message);
    return fallback;
  }
}

// --- Users -----------------------------------------------------------------

export type CreateUserResult =
  | { ok: true; user: PersistedUser }
  | { ok: false; reason: "duplicate" | "unavailable" };

// Emails are expected already normalized (lowercased/trimmed) by the caller so
// the UNIQUE constraint and lookups stay consistent.
export async function createUser(params: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<CreateUserResult> {
  if (!pool) return { ok: false, reason: "unavailable" };
  try {
    await migrate();
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)`, [
      id,
      params.email,
      params.passwordHash,
      params.name,
    ]);
    return { ok: true, user: { id, email: params.email, name: params.name } };
  } catch (err) {
    // 23505 = unique_violation (email already registered).
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "duplicate" };
    console.error("Error creando usuario:", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }
}

function toAuthRow(row: {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  google_id: string | null;
}): UserAuthRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    googleId: row.google_id,
  };
}

export function getUserByEmail(email: string): Promise<UserAuthRow | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT id, email, name, password_hash, google_id FROM users WHERE email = $1`,
      [email]
    );
    return rows[0] ? toAuthRow(rows[0]) : null;
  }, null);
}

export function getUserByGoogleId(googleId: string): Promise<UserAuthRow | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT id, email, name, password_hash, google_id FROM users WHERE google_id = $1`,
      [googleId]
    );
    return rows[0] ? toAuthRow(rows[0]) : null;
  }, null);
}

// Full row (incl. password hash) by id -- used for the change-password flow,
// which needs to verify the current password before setting a new one.
export function getUserAuthById(id: string): Promise<UserAuthRow | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT id, email, name, password_hash, google_id FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] ? toAuthRow(rows[0]) : null;
  }, null);
}

export function getUserById(id: string): Promise<PersistedUser | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT id, email, name FROM users WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? { id: row.id, email: row.email, name: row.name } : null;
  }, null);
}

// Creates an account from a first-time Google Sign-In -- no password, only
// usable via Google from then on (unless they later set one -- not built yet).
export async function createUserWithGoogle(params: {
  email: string;
  name: string;
  googleId: string;
}): Promise<PersistedUser> {
  if (!pool) throw new Error("La base de datos no está configurada.");
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO users (id, email, password_hash, name, google_id) VALUES ($1, $2, NULL, $3, $4)`,
    [id, params.email, params.name, params.googleId]
  );
  return { id, email: params.email, name: params.name };
}

// Attaches a Google account to an existing email/password account the first
// time that person uses "Continuar con Google" with the same email --
// merges the two instead of failing on the duplicate-email constraint.
export function linkGoogleId(userId: string, googleId: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET google_id = $2 WHERE id = $1`, [userId, googleId]);
  }, undefined);
}

export function updateUserName(id: string, name: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET name = $2 WHERE id = $1`, [id, name]);
  }, undefined);
}

export function updateUserPasswordHash(id: string, passwordHash: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  }, undefined);
}

// --- Microsoft/Outlook calendar tokens -------------------------------------

export function setMsRefreshToken(userId: string, token: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET ms_refresh_token = $2 WHERE id = $1`, [userId, token]);
  }, undefined);
}

export function getMsRefreshToken(userId: string): Promise<string | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT ms_refresh_token FROM users WHERE id = $1`, [userId]);
    return (rows[0]?.ms_refresh_token as string | null) ?? null;
  }, null);
}

export function clearMsRefreshToken(userId: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET ms_refresh_token = NULL WHERE id = $1`, [userId]);
  }, undefined);
}

// --- Folders ---------------------------------------------------------------

export function createFolder(ownerId: string, name: string): Promise<FolderSummary | null> {
  return safe(async () => {
    const id = randomUUID();
    const { rows } = await pool!.query(
      `INSERT INTO folders (id, owner_id, name) VALUES ($1, $2, $3) RETURNING created_at`,
      [id, ownerId, name]
    );
    return { id, name, createdAt: rows[0].created_at, meetingCount: 0 };
  }, null);
}

// Folders the user OWNS, each with how many meetings it holds.
export function listFolders(ownerId: string): Promise<FolderSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT f.id, f.name, f.created_at,
              (SELECT count(*) FROM meetings m WHERE m.folder_id = f.id) AS meeting_count,
              (SELECT count(*) FROM folder_shares s WHERE s.folder_id = f.id) AS shared_count
       FROM folders f
       WHERE f.owner_id = $1
       ORDER BY f.name ASC`,
      [ownerId]
    );
    return rows.map(
      (r): FolderSummary => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        meetingCount: Number(r.meeting_count),
        sharedWithCount: Number(r.shared_count),
      })
    );
  }, []);
}

// Folders shared WITH this user by someone else (read-only). Includes the
// owner's name so the UI can show "Ingeniería · de Papá".
export function listSharedFolders(userId: string): Promise<FolderSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT f.id, f.name, f.created_at, u.name AS owner_name,
              (SELECT count(*) FROM meetings m WHERE m.folder_id = f.id) AS meeting_count
       FROM folder_shares s
       JOIN folders f ON f.id = s.folder_id
       JOIN users u ON u.id = f.owner_id
       WHERE s.shared_with_user_id = $1
       ORDER BY f.name ASC`,
      [userId]
    );
    return rows.map(
      (r): FolderSummary => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        meetingCount: Number(r.meeting_count),
        ownerName: r.owner_name,
      })
    );
  }, []);
}

export function renameFolder(id: string, ownerId: string, name: string): Promise<boolean> {
  return safe(async () => {
    const r = await pool!.query(`UPDATE folders SET name = $3 WHERE id = $1 AND owner_id = $2`, [
      id,
      ownerId,
      name,
    ]);
    return (r.rowCount ?? 0) > 0;
  }, false);
}

// Deleting a folder frees its meetings (folder_id -> NULL) rather than
// deleting them; the shares cascade away via the FK.
export function deleteFolder(id: string, ownerId: string): Promise<boolean> {
  return safe(async () => {
    const owned = await pool!.query(`SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2`, [
      id,
      ownerId,
    ]);
    if (owned.rowCount === 0) return false;
    await pool!.query(`UPDATE meetings SET folder_id = NULL WHERE folder_id = $1`, [id]);
    await pool!.query(`DELETE FROM folders WHERE id = $1`, [id]);
    return true;
  }, false);
}

// Moves one of the user's OWN meetings into one of their OWN folders (or out,
// when folderId is null). Both ownership checks are enforced in SQL so a user
// can't file a meeting they don't own, nor into someone else's folder.
export function moveMeetingToFolder(
  meetingId: string,
  ownerId: string,
  folderId: string | null
): Promise<boolean> {
  return safe(async () => {
    if (folderId) {
      const folder = await pool!.query(`SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2`, [
        folderId,
        ownerId,
      ]);
      if (folder.rowCount === 0) return false;
    }
    const r = await pool!.query(
      `UPDATE meetings SET folder_id = $3 WHERE id = $1 AND owner_id = $2`,
      [meetingId, ownerId, folderId]
    );
    return (r.rowCount ?? 0) > 0;
  }, false);
}

export type ShareFolderResult =
  | { ok: true }
  | { ok: false; reason: "not-owner" | "no-user" | "self" | "unavailable" };

// Shares an owned folder with the account that has `email`. The recipient
// must already have a Unify account (we don't invite by email here).
export function shareFolderWithEmail(
  folderId: string,
  ownerId: string,
  email: string
): Promise<ShareFolderResult> {
  return safe<ShareFolderResult>(async () => {
    const owned = await pool!.query(`SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2`, [
      folderId,
      ownerId,
    ]);
    if (owned.rowCount === 0) return { ok: false, reason: "not-owner" };
    const target = await pool!.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const targetId = target.rows[0]?.id as string | undefined;
    if (!targetId) return { ok: false, reason: "no-user" };
    if (targetId === ownerId) return { ok: false, reason: "self" };
    await pool!.query(
      `INSERT INTO folder_shares (folder_id, shared_with_user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [folderId, targetId]
    );
    return { ok: true };
  }, { ok: false, reason: "unavailable" });
}

export function unshareFolder(
  folderId: string,
  ownerId: string,
  targetUserId: string
): Promise<boolean> {
  return safe(async () => {
    const owned = await pool!.query(`SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2`, [
      folderId,
      ownerId,
    ]);
    if (owned.rowCount === 0) return false;
    await pool!.query(
      `DELETE FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2`,
      [folderId, targetUserId]
    );
    return true;
  }, false);
}

export interface FolderShareRecipient {
  userId: string;
  name: string;
  email: string;
}

export function listFolderShares(
  folderId: string,
  ownerId: string
): Promise<FolderShareRecipient[]> {
  return safe(async () => {
    const owned = await pool!.query(`SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2`, [
      folderId,
      ownerId,
    ]);
    if (owned.rowCount === 0) return [];
    const { rows } = await pool!.query(
      `SELECT u.id, u.name, u.email
       FROM folder_shares s JOIN users u ON u.id = s.shared_with_user_id
       WHERE s.folder_id = $1
       ORDER BY u.name ASC`,
      [folderId]
    );
    return rows.map((r) => ({ userId: r.id, name: r.name, email: r.email }));
  }, []);
}

// True when the user may read this folder: they own it, or it's shared with
// them. Used to gate folder-scoped meeting listing.
export function canAccessFolder(folderId: string, userId: string): Promise<boolean> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT 1 FROM folders WHERE id = $1 AND owner_id = $2
       UNION SELECT 1 FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2`,
      [folderId, userId]
    );
    return rows.length > 0;
  }, false);
}

// --- Meetings --------------------------------------------------------------

export function createMeetingRecord(params: {
  id: string;
  joinCode: string;
  hostName: string;
  roles: PersistedRole[];
  ownerId?: string | null;
}): Promise<void> {
  return safe(async () => {
    await pool!.query(
      `INSERT INTO meetings (id, join_code, host_name, roles, owner_id) VALUES ($1, $2, $3, $4, $5)`,
      [params.id, params.joinCode, params.hostName, JSON.stringify(params.roles), params.ownerId ?? null]
    );
  }, undefined);
}

export function updateMeetingRoles(id: string, roles: PersistedRole[]): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE meetings SET roles = $2 WHERE id = $1`, [id, JSON.stringify(roles)]);
  }, undefined);
}

export function updateParticipantsSnapshot(
  id: string,
  participants: PersistedParticipant[]
): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE meetings SET participants = $2 WHERE id = $1`, [
      id,
      JSON.stringify(participants),
    ]);
  }, undefined);
}

// Returns the new row's id (or null if there's no database configured / the
// insert failed) so a caller can later fold a follow-up speech fragment into
// this same row instead of leaving two half-sentences sitting side by side.
export function recordMessage(params: {
  meetingId: string;
  kind: "chat" | "transcript";
  senderName: string;
  roleName: string | null;
  text: string;
  sourceLang: string | null;
  // When the utterance was actually received (server clock), captured BEFORE
  // the cleanup/translation pipeline runs. Stored as created_at so the
  // video<->transcript sync reflects when a line was SPOKEN, not when the
  // (often several seconds later) DB insert finally happened -- and so lines
  // keep their spoken order even when cleanup latency varies between them.
  spokenAt?: Date;
}): Promise<number | null> {
  return safe(async () => {
    const { rows } = params.spokenAt
      ? await pool!.query(
          `INSERT INTO messages (meeting_id, kind, sender_name, role_name, text, source_lang, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [params.meetingId, params.kind, params.senderName, params.roleName, params.text, params.sourceLang, params.spokenAt]
        )
      : await pool!.query(
          `INSERT INTO messages (meeting_id, kind, sender_name, role_name, text, source_lang)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [params.meetingId, params.kind, params.senderName, params.roleName, params.text, params.sourceLang]
        );
    return (rows[0]?.id as number) ?? null;
  }, null);
}

export function updateMessageText(id: number, text: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE messages SET text = $2 WHERE id = $1`, [id, text]);
  }, undefined);
}

// Cheap existence check used to validate meeting ids coming from
// unauthenticated endpoints (recording upload) before doing work for them.
export function meetingExists(id: string): Promise<boolean> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT 1 FROM meetings WHERE id = $1`, [id]);
    return rows.length > 0;
  }, false);
}

export function finalizeMeeting(id: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE meetings SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, [id]);
  }, undefined);
}

// Records the real start of a recording in SERVER time the instant it begins
// (called from a client ping on record start). This is the accurate anchor for
// video<->transcript sync: it's the same clock as the transcript timestamps
// (no client/server skew) and it isn't inflated by the later upload delay the
// way back-computing from duration is. Overwrites on each start so re-recording
// re-anchors correctly.
export function markRecordingStarted(id: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE meetings SET recording_started_at = now() WHERE id = $1`, [id]);
  }, undefined);
}

// Stores the recording URL. For the sync anchor it keeps a real start timestamp
// pinged at record start (skew-free, no upload delay) when there is one, and
// only falls back to back-computing now()-duration for clients/paths that
// didn't ping.
export function attachRecording(id: string, url: string, durationMs?: number): Promise<void> {
  return safe(async () => {
    if (typeof durationMs === "number" && durationMs > 0 && durationMs < 24 * 3600_000) {
      await pool!.query(
        `UPDATE meetings
           SET recording_url = $2,
               recording_started_at = COALESCE(recording_started_at, now() - ($3 || ' milliseconds')::interval)
         WHERE id = $1`,
        [id, url, String(Math.round(durationMs))]
      );
    } else {
      await pool!.query(`UPDATE meetings SET recording_url = $2 WHERE id = $1`, [id, url]);
    }
  }, undefined);
}

// Deletes a meeting the user owns (its messages cascade via the FK). Returns
// false if the meeting isn't theirs, so a user can never delete someone
// else's -- not even one shared with them read-only.
export function deleteMeeting(id: string, ownerId: string): Promise<boolean> {
  return safe(async () => {
    const r = await pool!.query(`DELETE FROM meetings WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return (r.rowCount ?? 0) > 0;
  }, false);
}

// Lets a guest who created/joined an ownerless meeting (owner_id NULL --
// nobody was logged in at the time) claim it after registering/logging in,
// so it shows up in their history instead of being lost forever. Guarded by
// `owner_id IS NULL` so it can't steal a meeting someone else already owns.
export function claimMeeting(id: string, ownerId: string): Promise<boolean> {
  return safe(async () => {
    const result = await pool!.query(
      `UPDATE meetings SET owner_id = $2 WHERE id = $1 AND owner_id IS NULL`,
      [id, ownerId]
    );
    return (result.rowCount ?? 0) > 0;
  }, false);
}

// Only ever returns meetings owned by `ownerId` -- history is private per
// account, so a logged-in user never sees anyone else's meetings.
function toSummary(row: {
  id: string;
  join_code: string;
  host_name: string;
  participants: PersistedParticipant[] | null;
  recording_url: string | null;
  started_at: string;
  ended_at: string | null;
  message_count: number | string;
  folder_id: string | null;
  report: string | null;
}): MeetingSummary {
  return {
    id: row.id,
    joinCode: row.join_code,
    hostName: row.host_name,
    participants: row.participants ?? [],
    recordingUrl: row.recording_url,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    messageCount: Number(row.message_count),
    folderId: row.folder_id,
    hasReport: Boolean(row.report),
  };
}

const SUMMARY_COLUMNS = `m.id, m.join_code, m.host_name, m.participants, m.recording_url,
  m.started_at, m.ended_at, m.folder_id, m.report,
  (SELECT count(*) FROM messages msg WHERE msg.meeting_id = m.id) AS message_count`;

export function listMeetings(ownerId: string, limit = 50): Promise<MeetingSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT ${SUMMARY_COLUMNS} FROM meetings m
       WHERE m.owner_id = $1
       ORDER BY m.started_at DESC
       LIMIT $2`,
      [ownerId, limit]
    );
    return rows.map(toSummary);
  }, []);
}

// Meetings inside one folder. Caller must have already confirmed access to the
// folder (canAccessFolder) -- this doesn't re-check ownership, so a shared
// recipient sees every meeting in the folder regardless of who owns each one.
export function listMeetingsInFolder(folderId: string, limit = 200): Promise<MeetingSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT ${SUMMARY_COLUMNS} FROM meetings m
       WHERE m.folder_id = $1
       ORDER BY m.started_at DESC
       LIMIT $2`,
      [folderId, limit]
    );
    return rows.map(toSummary);
  }, []);
}

async function buildDetail(meeting: {
  id: string;
  join_code: string;
  host_name: string;
  roles: PersistedRole[] | null;
  participants: PersistedParticipant[] | null;
  recording_url: string | null;
  started_at: string;
  ended_at: string | null;
  folder_id: string | null;
  report: string | null;
  report_generated_at: string | null;
  recording_started_at: string | null;
}): Promise<MeetingDetail> {
  const { rows: messageRows } = await pool!.query(
    `SELECT id, kind, sender_name, role_name, text, source_lang, created_at
     FROM messages WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [meeting.id]
  );
  const messages: PersistedMessage[] = messageRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    senderName: row.sender_name,
    roleName: row.role_name,
    text: row.text,
    sourceLang: row.source_lang,
    createdAt: row.created_at,
  }));
  return {
    id: meeting.id,
    joinCode: meeting.join_code,
    hostName: meeting.host_name,
    roles: meeting.roles ?? [],
    participants: meeting.participants ?? [],
    recordingUrl: meeting.recording_url,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    folderId: meeting.folder_id,
    hasReport: Boolean(meeting.report),
    report: meeting.report,
    reportGeneratedAt: meeting.report_generated_at,
    recordingStartedAt: meeting.recording_started_at,
    messageCount: messages.length,
    messages,
  };
}

// Scoped to the owner: a user can only open the detail of their OWN meetings,
// never someone else's by guessing an id.
export function getMeetingDetail(id: string, ownerId: string): Promise<MeetingDetail | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT * FROM meetings WHERE id = $1 AND owner_id = $2`, [
      id,
      ownerId,
    ]);
    return rows[0] ? buildDetail(rows[0]) : null;
  }, null);
}

// Owner OR a folder-share recipient may open the meeting. Recipients get
// `sharedView: true` so the UI can hide owner-only actions (move, delete,
// re-share). The meeting must be filed in a folder that's shared with them.
export function getMeetingDetailForUser(
  id: string,
  userId: string
): Promise<MeetingDetail | null> {
  return safe(async () => {
    const owned = await pool!.query(`SELECT * FROM meetings WHERE id = $1 AND owner_id = $2`, [
      id,
      userId,
    ]);
    if (owned.rows[0]) return buildDetail(owned.rows[0]);

    const shared = await pool!.query(
      `SELECT m.* FROM meetings m
       JOIN folder_shares s ON s.folder_id = m.folder_id
       WHERE m.id = $1 AND s.shared_with_user_id = $2`,
      [id, userId]
    );
    if (!shared.rows[0]) return null;
    const detail = await buildDetail(shared.rows[0]);
    return { ...detail, sharedView: true };
  }, null);
}

// Whether the user can read this meeting at all (owner or via a shared
// folder) -- cheap check used before generating/reading its report.
export function canAccessMeeting(id: string, userId: string): Promise<boolean> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT 1 FROM meetings WHERE id = $1 AND owner_id = $2
       UNION
       SELECT 1 FROM meetings m JOIN folder_shares s ON s.folder_id = m.folder_id
       WHERE m.id = $1 AND s.shared_with_user_id = $2`,
      [id, userId]
    );
    return rows.length > 0;
  }, false);
}

export function saveMeetingReport(id: string, report: string): Promise<void> {
  return safe(async () => {
    await pool!.query(
      `UPDATE meetings SET report = $2, report_generated_at = now() WHERE id = $1`,
      [id, report]
    );
  }, undefined);
}

export function getMeetingReport(
  id: string
): Promise<{ report: string | null; reportGeneratedAt: string | null }> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT report, report_generated_at FROM meetings WHERE id = $1`,
      [id]
    );
    return {
      report: rows[0]?.report ?? null,
      reportGeneratedAt: rows[0]?.report_generated_at ?? null,
    };
  }, { report: null, reportGeneratedAt: null });
}
