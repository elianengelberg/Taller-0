import { CommunicationIdentityClient } from "@azure/communication-identity";

// Issues short-lived Azure Communication Services (ACS) user access tokens so
// the browser can join a Microsoft Teams meeting via ACS "Teams interop" --
// the official way to embed an arbitrary Teams meeting (by its join link) into
// a third-party web app (Teams has no Zoom-style Meeting SDK).
//
// The ACS connection string is the sensitive credential and lives ONLY here
// (set ACS_CONNECTION_STRING in Render). The client only ever receives a
// per-session token scoped to VoIP calling. If it's not configured we treat
// Teams as "not set up" and the token endpoint returns a clear 503, exactly
// like Zoom/storage/db degrade gracefully.

const CONNECTION_STRING = process.env.ACS_CONNECTION_STRING?.trim() ?? "";

export const teamsEnabled = Boolean(CONNECTION_STRING);

// Lazily constructed so a deploy without ACS never touches the SDK.
let identityClient: CommunicationIdentityClient | null = null;
function getIdentityClient(): CommunicationIdentityClient {
  if (!identityClient) {
    identityClient = new CommunicationIdentityClient(CONNECTION_STRING);
  }
  return identityClient;
}

export interface TeamsUserToken {
  token: string;
  userId: string;
  expiresOn: string;
}

// Creates a fresh ACS identity + a VoIP-scoped token for it. We mint a throwaway
// identity per join (simple and stateless); ACS identities are free and only
// the token has cost implications, so this keeps the flow credential-light.
export async function createTeamsUserToken(): Promise<TeamsUserToken> {
  if (!teamsEnabled) {
    throw new Error("Teams (ACS) no está configurado en el servidor.");
  }
  const { user, token, expiresOn } = await getIdentityClient().createUserAndToken(["voip"]);
  return {
    token,
    userId: user.communicationUserId,
    expiresOn: expiresOn.toISOString(),
  };
}
