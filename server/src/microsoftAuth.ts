// Outlook / Microsoft 365 calendar integration via plain OAuth 2.0 +
// Microsoft Graph -- no SDK, matching googleAuth.ts/zoom.ts. This is a
// CONNECT flow (attach a calendar to an already-logged-in Unify account),
// not a sign-in, so the OAuth `state` carries which Unify user is
// connecting. Requires the user to register their own Azure app (client id +
// secret) and set them as env vars -- never pasted in chat, same rule as
// every other third-party secret here. Degrades gracefully: when the env
// vars are missing, `microsoftEnabled` is false and every endpoint says so
// instead of erroring.
import { randomBytes } from "crypto";

const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
// Must exactly match a "Redirect URI" (Web) on the Azure app registration,
// e.g. https://your-backend.onrender.com/api/calendar/callback
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI;
// "common" lets both work/school (Outlook 365) and personal (outlook.com)
// accounts sign in. Override with MS_TENANT if you want to lock it to one org.
const TENANT = process.env.MS_TENANT || "common";

export const microsoftEnabled = Boolean(MS_CLIENT_ID && MS_CLIENT_SECRET && MS_REDIRECT_URI);

const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH_CALENDAR_VIEW = "https://graph.microsoft.com/v1.0/me/calendarView";

// offline_access is what makes Microsoft return a refresh_token so we can
// read the calendar later without the user present.
const SCOPES = "openid offline_access Calendars.Read User.Read";

// state -> { userId, expiresAt }: binds the OAuth round trip to the Unify
// account that started it (the callback is unauthenticated), and doubles as
// the CSRF guard. In-memory is fine -- the round trip takes seconds.
const pendingStates = new Map<string, { userId: string; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createCalendarState(userId: string): string {
  const now = Date.now();
  for (const [key, v] of pendingStates) {
    if (v.expiresAt <= now) pendingStates.delete(key);
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, { userId, expiresAt: now + STATE_TTL_MS });
  return state;
}

export function consumeCalendarState(state: string | undefined): string | null {
  if (!state) return null;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

export function calendarAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID!,
    response_type: "code",
    redirect_uri: MS_REDIRECT_URI!,
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error_description?: string;
}

// Exchanges the one-time auth code for tokens. Returns the refresh_token
// (persisted) and the immediately-usable access_token.
export async function exchangeCalendarCode(
  code: string
): Promise<{ refreshToken: string; accessToken: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID!,
      client_secret: MS_CLIENT_SECRET!,
      redirect_uri: MS_REDIRECT_URI!,
      grant_type: "authorization_code",
      code,
      scope: SCOPES,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    throw new Error(data.error_description || `Microsoft rechazó el código (${res.status}).`);
  }
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

// Trades the stored refresh token for a fresh access token. Microsoft may
// rotate the refresh token; the new one (if any) is returned so the caller
// can persist it.
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID!,
      client_secret: MS_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: SCOPES,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || `No se pudo renovar el acceso (${res.status}).`);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null };
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string; // ISO
  end: string; // ISO
  organizer: string | null;
  // A join link if the event is an online meeting (Meet/Teams/Zoom), else null.
  joinUrl: string | null;
  platform: "google-meet" | "microsoft-teams" | "zoom" | "other" | null;
}

const MEET_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
const TEAMS_RE = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+/i;
const ZOOM_RE = /https:\/\/[\w.-]*zoom\.us\/j\/\d+[^\s"'<>]*/i;

function extractJoin(fields: string): { url: string; platform: CalendarEvent["platform"] } | null {
  const meet = fields.match(MEET_RE);
  if (meet) return { url: meet[0], platform: "google-meet" };
  const teams = fields.match(TEAMS_RE);
  if (teams) return { url: teams[0], platform: "microsoft-teams" };
  const zoom = fields.match(ZOOM_RE);
  if (zoom) return { url: zoom[0], platform: "zoom" };
  return null;
}

interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  organizer?: { emailAddress?: { name?: string } };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string } | null;
  bodyPreview?: string;
  body?: { content?: string } | null;
}

// Fetches events between now and `hoursAhead` from now, using calendarView so
// recurring-event instances are already expanded by Graph.
export async function fetchUpcomingEvents(
  accessToken: string,
  hoursAhead = 12
): Promise<CalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + hoursAhead * 3600_000);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: "start/dateTime",
    $top: "25",
    $select: "id,subject,start,end,organizer,onlineMeeting,onlineMeetingUrl,location,bodyPreview,body",
  });
  const res = await fetch(`${GRAPH_CALENDAR_VIEW}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // UTC so the ISO strings we send/receive line up regardless of the
      // mailbox's default timezone.
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    throw new Error(`Graph devolvió ${res.status}.`);
  }
  const data = (await res.json()) as { value?: GraphEvent[] };
  return (data.value ?? []).map((ev): CalendarEvent => {
    const haystack = [
      ev.onlineMeeting?.joinUrl ?? "",
      ev.onlineMeetingUrl ?? "",
      ev.location?.displayName ?? "",
      ev.bodyPreview ?? "",
      ev.body?.content ?? "",
    ].join(" ");
    const join = extractJoin(haystack);
    return {
      id: ev.id,
      subject: ev.subject?.slice(0, 200) || "(sin título)",
      start: ev.start?.dateTime ? `${ev.start.dateTime}Z`.replace(/Z+$/, "Z") : now.toISOString(),
      end: ev.end?.dateTime ? `${ev.end.dateTime}Z`.replace(/Z+$/, "Z") : end.toISOString(),
      organizer: ev.organizer?.emailAddress?.name ?? null,
      joinUrl: join?.url ?? null,
      platform: join?.platform ?? (haystack.trim() ? "other" : null),
    };
  });
}
