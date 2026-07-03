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

export function createMeetingRecord(params: {
  id: string;
  joinCode: string;
  hostName: string;
  roles: PersistedRole[];
}): Promise<void> {
  return safe(async () => {
    await pool!.query(
      `INSERT INTO meetings (id, join_code, host_name, roles) VALUES ($1, $2, $3, $4)`,
      [params.id, params.joinCode, params.hostName, JSON.stringify(params.roles)]
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

export function listMeetings(limit = 50): Promise<MeetingSummary[]> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT m.id, m.join_code, m.host_name, m.participants, m.recording_url, m.started_at, m.ended_at,
              (SELECT count(*) FROM messages msg WHERE msg.meeting_id = m.id) AS message_count
       FROM meetings m
       ORDER BY m.started_at DESC
       LIMIT $1`,
      [limit]
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

export function getMeetingDetail(id: string): Promise<MeetingDetail | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT * FROM meetings WHERE id = $1`, [id]);
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
