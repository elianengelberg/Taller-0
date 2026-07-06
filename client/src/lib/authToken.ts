// The current session token, persisted in localStorage so a login survives a
// page reload. Kept in its own tiny module (not the React context) so
// non-React code -- api.ts fetches, the socket's create-meeting emit -- can
// read it too, without coupling to the provider.
const KEY = "encuentro_token";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / storage disabled -- session just won't persist */
  }
}
