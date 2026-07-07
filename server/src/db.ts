import { randomUUID } from "crypto";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const isLocal = !!DATABASE_URL && /localhost|127\.0\.0\.1/.test(DATABASE_URL);

export const dbEnabled = Boolean(DATABASE_URL);

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
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
}

export interface MeetingDetail extends MeetingSummary {
  roles: PersistedRole[];
  messages: PersistedMessage[];
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
}): Promise<number | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
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

export function attachRecording(id: string, url: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE meetings SET recording_url = $2 WHERE id = $1`, [id, url]);
  }, undefined);
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
export function listMeetings(ownerId: string, limit = 50): Promise<MeetingSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT m.id, m.join_code, m.host_name, m.participants, m.recording_url, m.started_at, m.ended_at,
              (SELECT count(*) FROM messages msg WHERE msg.meeting_id = m.id) AS message_count
       FROM meetings m
       WHERE m.owner_id = $1
       ORDER BY m.started_at DESC
       LIMIT $2`,
      [ownerId, limit]
    );
    return rows.map(
      (row): MeetingSummary => ({
        id: row.id,
        joinCode: row.join_code,
        hostName: row.host_name,
        participants: row.participants ?? [],
        recordingUrl: row.recording_url,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        messageCount: Number(row.message_count),
      })
    );
  }, []);
}

// Scoped to the owner: a user can only open the detail of their OWN meetings,
// never someone else's by guessing an id.
export function getMeetingDetail(id: string, ownerId: string): Promise<MeetingDetail | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT * FROM meetings WHERE id = $1 AND owner_id = $2`, [
      id,
      ownerId,
    ]);
    const meeting = rows[0];
    if (!meeting) return null;

    const { rows: messageRows } = await pool!.query(
      `SELECT id, kind, sender_name, role_name, text, source_lang, created_at
       FROM messages WHERE meeting_id = $1 ORDER BY created_at ASC`,
      [id]
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
      messageCount: messages.length,
      messages,
    };
  }, null);
}
