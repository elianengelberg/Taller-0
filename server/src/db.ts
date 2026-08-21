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
      // Foto de perfil: la que trae la cuenta de Google al iniciar sesión, o
      // una que la persona suba después. Guardamos la URL, no la imagen: las de
      // Google ya viven en su CDN y las nuestras en el bucket (ver storage.ts),
      // así la foto no engorda cada snapshot de la reunión.
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`))
      // ¿Está probado que esta persona es dueña de ese email? Google lo prueba;
      // registrarse con email y contraseña, no. La diferencia importa: sin ella,
      // cualquiera podía registrar la cuenta con el email de otro y quedarse
      // adentro cuando el dueño real entrara con Google (ver el callback).
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;`))
      // Las cuentas que ya existen y entran por Google tienen su email probado
      // por Google desde siempre.
      .then(() => pool.query(`UPDATE users SET email_verified = TRUE WHERE google_id IS NOT NULL AND email_verified = FALSE;`))
      // Versión de sesión: viaja dentro del token y se incrementa al cambiar la
      // contraseña o al cerrar sesión en todos lados. Subirla mata de golpe cada
      // token emitido antes -- que es lo único que saca de la cuenta a alguien
      // que ya te robó la sesión.
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;`))
      // ¿A esta cuenta se le exige tener el email verificado para iniciar
      // sesión? Se marca al crearla, y sólo cuando el servidor sabía mandar
      // correos en ese momento. Las cuentas anteriores a la verificación
      // quedan en FALSE a propósito: nadie que ya usaba Unify se queda
      // afuera de un día para el otro por una función que no existía cuando
      // se registró.
      .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_required BOOLEAN NOT NULL DEFAULT FALSE;`))
      // Enlaces de un solo uso que se mandan por correo: verificar el email y
      // restablecer la contraseña. Se guarda el HASH, nunca el token: si
      // alguien se lleva una copia de la base, no puede usar los enlaces que
      // están en vuelo -- igual que con las contraseñas.
      .then(() =>
        pool.query(
          `CREATE TABLE IF NOT EXISTS auth_tokens (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            purpose TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );`
        )
      )
      .then(() =>
        pool.query(
          `CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens(user_id, purpose);`
        )
      )
      // El código de 6 dígitos del correo: la segunda forma de canjear el
      // MISMO token (para quien prefiere escribirlo a tocar el enlace, o
      // recibe el mail en el teléfono y trabaja en la computadora). Se guarda
      // hasheado igual que el enlace, y `attempts` es lo que hace que 6
      // dígitos sean seguros: sin contador, un millón de intentos lo rompen.
      .then(() => pool.query(`ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS code_hash TEXT;`))
      .then(() =>
        pool.query(`ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;`)
      )
      // Buscar "el código vigente de este email": el canje por código no
      // conoce el hash del token, llega con la dirección y seis dígitos.
      .then(() =>
        pool.query(
          `CREATE INDEX IF NOT EXISTS auth_tokens_email_purpose_idx ON auth_tokens(email, purpose);`
        )
      )
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
  /** URL de la foto de perfil, o null si no tiene. */
  avatarUrl: string | null;
  /** Está probado que el email es de esta persona (Google o enlace por correo). */
  emailVerified: boolean;
}

// passwordHash is null for accounts created via Google Sign-In that never
// set a password -- callers must check before handing it to verifyPassword.
type UserAuthRow = PersistedUser & {
  passwordHash: string | null;
  googleId: string | null;
  /** Los tokens con una versión menor a esta ya no valen. */
  tokenVersion: number;
  /** A esta cuenta se le exige el email verificado para iniciar sesión. */
  verificationRequired: boolean;
};

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
  /**
   * Exigir el email verificado para iniciar sesión. Lo decide index.ts según
   * si el servidor sabe mandar correos: no se le puede pedir a nadie que
   * confirme un email si el correo nunca va a salir.
   */
  verificationRequired: boolean;
}): Promise<CreateUserResult> {
  if (!pool) return { ok: false, reason: "unavailable" };
  try {
    await migrate();
    const id = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, verification_required) VALUES ($1, $2, $3, $4, $5)`,
      [id, params.email, params.passwordHash, params.name, params.verificationRequired]
    );
    return {
      ok: true,
      user: { id, email: params.email, name: params.name, avatarUrl: null, emailVerified: false },
    };
  } catch (err) {
    // 23505 = unique_violation (email already registered).
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "duplicate" };
    console.error("Error creando usuario:", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }
}

// Una sola lista de columnas para las tres consultas de autenticación: si
// mañana se agrega otra, agregarla en un lado y olvidarla en otro es
// exactamente el tipo de descuido que deja pasar un token viejo.
const AUTH_COLUMNS =
  "id, email, name, avatar_url, password_hash, google_id, email_verified, token_version, verification_required";

function toAuthRow(row: {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string | null;
  google_id: string | null;
  email_verified?: boolean;
  token_version?: number;
  verification_required?: boolean;
}): UserAuthRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url ?? null,
    passwordHash: row.password_hash,
    googleId: row.google_id,
    emailVerified: Boolean(row.email_verified),
    tokenVersion: row.token_version ?? 1,
    verificationRequired: Boolean(row.verification_required),
  };
}

export function getUserByEmail(email: string): Promise<UserAuthRow | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT ${AUTH_COLUMNS} FROM users WHERE email = $1`,
      [email]
    );
    return rows[0] ? toAuthRow(rows[0]) : null;
  }, null);
}

export function getUserByGoogleId(googleId: string): Promise<UserAuthRow | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT ${AUTH_COLUMNS} FROM users WHERE google_id = $1`,
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
      `SELECT ${AUTH_COLUMNS} FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] ? toAuthRow(rows[0]) : null;
  }, null);
}

export function getUserById(id: string): Promise<PersistedUser | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT id, email, name, avatar_url, email_verified FROM users WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          email: row.email,
          name: row.name,
          avatarUrl: row.avatar_url ?? null,
          emailVerified: Boolean(row.email_verified),
        }
      : null;
  }, null);
}

// Creates an account from a first-time Google Sign-In -- no password, only
// usable via Google from then on (unless they later set one -- not built yet).
export async function createUserWithGoogle(params: {
  email: string;
  name: string;
  googleId: string;
  /** Foto del perfil de Google, si la cuenta tiene una. */
  avatarUrl?: string | null;
}): Promise<PersistedUser> {
  if (!pool) throw new Error("La base de datos no está configurada.");
  const id = randomUUID();
  const avatarUrl = params.avatarUrl ?? null;
  // email_verified = TRUE de entrada: Google ya probó que la dirección es de
  // esta persona, que es justo lo que el enlace por correo va a buscar.
  await pool!.query(
    `INSERT INTO users (id, email, password_hash, name, google_id, avatar_url, email_verified)
     VALUES ($1, $2, NULL, $3, $4, $5, TRUE)`,
    [id, params.email, params.name, params.googleId, avatarUrl]
  );
  return { id, email: params.email, name: params.name, avatarUrl, emailVerified: true };
}

// La foto que Google ya tiene sólo se copia si la persona todavía no eligió
// una: quien subió la suya no quiere que un login se la pise.
export function setAvatarIfMissing(userId: string, avatarUrl: string): Promise<void> {
  return safe(async () => {
    await pool!.query(
      `UPDATE users SET avatar_url = $2 WHERE id = $1 AND (avatar_url IS NULL OR avatar_url = '')`,
      [userId, avatarUrl]
    );
  }, undefined);
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

/** `null` saca la foto; una URL la reemplaza. */
export function updateUserAvatar(id: string, avatarUrl: string | null): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET avatar_url = $2 WHERE id = $1`, [id, avatarUrl]);
  }, undefined);
}

export function updateUserPasswordHash(id: string, passwordHash: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  }, undefined);
}

/**
 * Invalida TODAS las sesiones abiertas de esta cuenta y devuelve la versión
 * nueva. Se llama al cambiar la contraseña y al pedir "cerrar sesión en todos
 * lados": sin esto, cambiar la contraseña no echaba a quien ya tenía tu token.
 */
export function bumpTokenVersion(id: string): Promise<number> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`,
      [id]
    );
    return (rows[0]?.token_version as number) ?? 1;
  }, 1);
}

/** Sólo la versión de sesión vigente, para validar un token. */
export function getTokenVersion(id: string): Promise<number | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT token_version FROM users WHERE id = $1`, [id]);
    return rows[0] ? ((rows[0].token_version as number) ?? 1) : null;
  }, null);
}

/**
 * Google acaba de probar que esta persona es dueña del email. Si la cuenta
 * tenía una contraseña puesta por alguien que NUNCA probó ser dueño del email,
 * esa contraseña se borra: es la única forma de sacar de la cuenta a quien la
 * registró primero con el email ajeno. Devuelve si hubo que borrarla.
 */
export function claimAccountForVerifiedEmail(
  id: string,
  googleId: string
): Promise<{ passwordCleared: boolean }> {
  return safe(async () => {
    // Se lee primero para no depender del orden de evaluación de un RETURNING
    // sobre la misma fila que se está actualizando.
    const { rows } = await pool!.query(`SELECT email_verified FROM users WHERE id = $1`, [id]);
    const wasVerified = Boolean(rows[0]?.email_verified);
    if (wasVerified) {
      await pool!.query(`UPDATE users SET google_id = $2 WHERE id = $1`, [id, googleId]);
      return { passwordCleared: false };
    }
    // Nunca se probó que quien puso esa contraseña fuera dueño del email.
    // Google acaba de probar lo contrario, así que la contraseña se va y las
    // sesiones abiertas con ella también.
    await pool!.query(
      `UPDATE users
          SET google_id = $2, email_verified = TRUE, password_hash = NULL,
              token_version = token_version + 1
        WHERE id = $1`,
      [id, googleId]
    );
    return { passwordCleared: true };
  }, { passwordCleared: false });
}

// --- Enlaces de un solo uso enviados por correo ------------------------------

export type AuthTokenPurpose = "verify-email" | "reset-password";

/**
 * Guarda un enlace pendiente. Recibe el HASH, no el token: el token en claro
 * existe sólo el instante que tarda en irse dentro del correo.
 *
 * `false` significa que no se pudo guardar, y quien llama NO debe mandar el
 * correo: un enlace que la base no conoce no se puede canjear, y la persona se
 * queda esperando un mail que no sirve.
 */
export function createAuthToken(params: {
  userId: string;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  /** Hash del código de 6 dígitos que va grande en el correo. */
  codeHash?: string;
  email: string;
  ttlMs: number;
}): Promise<boolean> {
  return safe(async () => {
    // Barrido barato de lo que ya no sirve, aprovechando que estamos acá: sin
    // esto la tabla crece para siempre con enlaces vencidos.
    await pool!.query(`DELETE FROM auth_tokens WHERE expires_at < now() - INTERVAL '7 days'`);
    // Un código nuevo apaga los CÓDIGOS anteriores, y sólo los códigos: si no,
    // cada reenvío dejaría otro número de 6 dígitos vivo y multiplicaría las
    // chances de acertar a ciegas.
    //
    // Los ENLACES de esos correos siguen valiendo a propósito. Son secretos de
    // 256 bits, no hay fuerza bruta que los alcance, y matarlos rompía algo
    // real: el servidor manda un correo nuevo solo cuando alguien intenta
    // entrar sin verificar, así que el enlace del primer correo se moría en la
    // mano de la persona sin que hiciera nada. (Lo encontró sim_email.)
    if (params.codeHash) {
      await pool!.query(
        `UPDATE auth_tokens SET code_hash = NULL
          WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
        [params.userId, params.purpose]
      );
    }
    await pool!.query(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, code_hash, email, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint * INTERVAL '1 millisecond'))`,
      [
        randomUUID(),
        params.userId,
        params.purpose,
        params.tokenHash,
        params.codeHash ?? null,
        params.email,
        params.ttlMs,
      ]
    );
    return true;
  }, false);
}

/**
 * Canje por CÓDIGO (los 6 dígitos del correo), buscando por email.
 *
 * Lo que hace seguro a un código corto no es el código: es este contador. Cada
 * intento fallido suma uno y al sexto el token queda quemado, así que un
 * atacante tiene 6 tiros sobre un millón de combinaciones -- y para conseguir
 * otros 6 necesita provocar otro correo, cosa que el tope por cuenta
 * (LINKS_PER_HOUR) limita a 5 por hora. La comparación es por hash, y el
 * UPDATE atómico impide que dos pedidos simultáneos canjeen el mismo token.
 *
 * Devuelve el motivo del fallo para poder decir la verdad ("te quedan 3
 * intentos" / "ese código venció") sin filtrar si el email existe: eso lo
 * decide quien llama.
 */
export function consumeAuthTokenByCode(params: {
  email: string;
  purpose: AuthTokenPurpose;
  codeHash: string;
}): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "sin-codigo" | "incorrecto" | "sin-intentos"; left?: number }
> {
  return safe(async () => {
    const MAX_INTENTOS = 5;
    const { rows } = await pool!.query(
      `SELECT id, user_id, email, code_hash, attempts FROM auth_tokens
        WHERE lower(email) = lower($1) AND purpose = $2 AND used_at IS NULL
          AND expires_at > now() AND code_hash IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [params.email, params.purpose]
    );
    const fila = rows[0];
    if (!fila) return { ok: false as const, reason: "sin-codigo" as const };
    if (fila.attempts >= MAX_INTENTOS) {
      await pool!.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [fila.id]);
      return { ok: false as const, reason: "sin-intentos" as const };
    }
    if (fila.code_hash !== params.codeHash) {
      const { rows: tras } = await pool!.query(
        `UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
        [fila.id]
      );
      const usados = (tras[0]?.attempts as number) ?? MAX_INTENTOS;
      // Agotados los intentos, el token muere: no se le regala al atacante
      // una ventana más grande sólo porque siga probando.
      if (usados >= MAX_INTENTOS) {
        await pool!.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [fila.id]);
        return { ok: false as const, reason: "sin-intentos" as const };
      }
      return { ok: false as const, reason: "incorrecto" as const, left: MAX_INTENTOS - usados };
    }
    const { rows: canje } = await pool!.query(
      `UPDATE auth_tokens SET used_at = now()
        WHERE id = $1 AND used_at IS NULL
        RETURNING user_id, email`,
      [fila.id]
    );
    if (!canje[0]) return { ok: false as const, reason: "sin-codigo" as const };
    return {
      ok: true as const,
      userId: canje[0].user_id as string,
      email: canje[0].email as string,
    };
  }, { ok: false as const, reason: "sin-codigo" as const });
}

/**
 * Canjea un enlace. La marca de usado va en el MISMO UPDATE que lo busca, así
 * que dos pedidos simultáneos con el mismo token no pueden ganar los dos: uno
 * actualiza la fila y el otro no encuentra nada. Un `SELECT` y después un
 * `UPDATE` habría dejado esa carrera abierta.
 */
export function consumeAuthToken(
  tokenHash: string,
  purpose: AuthTokenPurpose
): Promise<{ userId: string; email: string } | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id, email`,
      [tokenHash, purpose]
    );
    return rows[0] ? { userId: rows[0].user_id as string, email: rows[0].email as string } : null;
  }, null);
}

/**
 * Mira un enlace sin gastarlo. Existe por un motivo de trato, no de seguridad:
 * el restablecimiento necesita el email de la cuenta para poder decir "esa
 * contraseña contiene tu email" ANTES de quemar el enlace. Si se canjeara
 * primero, escribir una contraseña débil te dejaría sin enlace y sin
 * contraseña nueva, obligándote a pedir otro correo.
 *
 * No abre ninguna carrera: el canje sigue siendo un único UPDATE atómico, así
 * que de dos pedidos simultáneos uno gana y el otro ve "ya se usó".
 */
export function peekAuthToken(
  tokenHash: string,
  purpose: AuthTokenPurpose
): Promise<{ userId: string; email: string } | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT user_id, email FROM auth_tokens
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash, purpose]
    );
    return rows[0] ? { userId: rows[0].user_id as string, email: rows[0].email as string } : null;
  }, null);
}

/**
 * ¿Este token ya se usó hace poco? Sirve para que volver a abrir el enlace de
 * verificación (el segundo clic, el "atrás" del navegador, o el escáner de
 * correo del trabajo que lo abre antes que vos) muestre "listo" en vez de un
 * error asustador. Sólo se usa para verificar el email: restablecer la
 * contraseña sigue siendo estrictamente de un solo uso.
 */
export function wasAuthTokenRecentlyUsed(
  tokenHash: string,
  purpose: AuthTokenPurpose
): Promise<string | null> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT user_id FROM auth_tokens
        WHERE token_hash = $1 AND purpose = $2 AND used_at > now() - INTERVAL '24 hours'`,
      [tokenHash, purpose]
    );
    return (rows[0]?.user_id as string) ?? null;
  }, null);
}

/** Cuántos enlaces de este tipo se emitieron para esta cuenta en la ventana. */
export function countRecentAuthTokens(
  userId: string,
  purpose: AuthTokenPurpose,
  windowMs: number
): Promise<number> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `SELECT count(*)::int AS n FROM auth_tokens
        WHERE user_id = $1 AND purpose = $2
          AND created_at > now() - ($3::bigint * INTERVAL '1 millisecond')`,
      [userId, purpose, windowMs]
    );
    return (rows[0]?.n as number) ?? 0;
  }, 0);
}

/** Quema los enlaces pendientes de ese tipo (al usar uno, o al cambiar la clave). */
export function invalidateAuthTokens(userId: string, purpose: AuthTokenPurpose): Promise<void> {
  return safe(async () => {
    await pool!.query(
      `UPDATE auth_tokens SET used_at = now()
        WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose]
    );
  }, undefined);
}

/** El email quedó probado. Sólo lo llama el canje de un enlace de verificación. */
export function markEmailVerified(id: string): Promise<void> {
  return safe(async () => {
    await pool!.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [id]);
  }, undefined);
}

/**
 * Cierre del restablecimiento, en una sola sentencia porque las tres cosas
 * tienen que pasar juntas o ninguna:
 *
 *  - la contraseña nueva queda puesta;
 *  - el email queda verificado (quien abrió el enlace probó tener el buzón);
 *  - sube token_version, así que TODA sesión abierta antes deja de valer.
 *
 * Ese último punto es el que convierte esto en una recuperación de verdad: si
 * alguien te había entrado a la cuenta, restablecer lo echa en el acto.
 */
export function applyPasswordReset(id: string, passwordHash: string): Promise<number> {
  return safe(async () => {
    const { rows } = await pool!.query(
      `UPDATE users
          SET password_hash = $2, email_verified = TRUE, token_version = token_version + 1
        WHERE id = $1
        RETURNING token_version`,
      [id, passwordHash]
    );
    return (rows[0]?.token_version as number) ?? 1;
  }, 1);
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
  /**
   * Si esa cuenta nunca probó ser dueña de su email, compartirle una carpeta
   * es compartírsela a quien haya escrito esa dirección primero. No se
   * bloquea (habría dejado de andar para todas las cuentas anteriores a la
   * verificación), pero quien comparte tiene derecho a verlo.
   */
  emailVerified: boolean;
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
      `SELECT u.id, u.name, u.email, u.email_verified
       FROM folder_shares s JOIN users u ON u.id = s.shared_with_user_id
       WHERE s.folder_id = $1
       ORDER BY u.name ASC`,
      [folderId]
    );
    return rows.map((r) => ({
      userId: r.id,
      name: r.name,
      email: r.email,
      emailVerified: Boolean(r.email_verified),
    }));
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
// Builds a meeting's full detail WITHOUT any ownership check. The caller is
// responsible for authorizing first (e.g. the requester is the owner, a
// folder-share recipient, or -- for a live meeting -- a current participant).
export function getMeetingDetailRaw(id: string): Promise<MeetingDetail | null> {
  return safe(async () => {
    const { rows } = await pool!.query(`SELECT * FROM meetings WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return buildDetail(rows[0]);
  }, null);
}

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
