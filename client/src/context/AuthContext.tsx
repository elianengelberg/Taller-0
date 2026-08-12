import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { AuthUser, authLogin, authMe, authRegister } from "../lib/api";
import { getAuthToken, setAuthToken } from "../lib/authToken";

export interface LoginFailure {
  message: string;
  /** Falta abrir el enlace del correo; ya se lo reenviamos. */
  needsVerification: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  // True only while we're validating a stored token on first load, so pages
  // can wait instead of briefly flashing the logged-out state.
  loading: boolean;
  // Ambos devuelven null si salió bien. Si no, un mensaje para mostrar --
  // más, en el caso de entrar, si lo único que falta es confirmar el email
  // (la contraseña era correcta), porque eso se resuelve distinto: no se
  // arregla escribiendo otra cosa, sino abriendo el correo.
  login: (email: string, password: string) => Promise<LoginFailure | null>;
  register: (email: string, password: string, name: string) => Promise<string | null>;
  logout: () => void;
  // Applies a freshly-saved profile (e.g. after renaming in Settings) so the
  // header greeting etc. update immediately without a full reload.
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On load, if there's a stored token, confirm it's still valid (and fetch
  // the current user). Only an explicit 401 clears the stored token -- if
  // the server just couldn't be reached (free-tier cold start, network
  // blip), the token survives so the next load can retry instead of
  // permanently logging the person out over a transient outage.
  useEffect(() => {
    let cancelled = false;
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }
    authMe().then(({ user: fetchedUser, unauthorized }) => {
      if (cancelled) return;
      if (unauthorized) setAuthToken(null);
      setUser(fetchedUser);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email: string, password: string): Promise<LoginFailure | null> {
    const res = await authLogin(email, password);
    if (res.error || !res.token || !res.user) {
      return {
        message: res.error ?? "No se pudo iniciar sesión.",
        needsVerification: res.needsVerification === true,
      };
    }
    setAuthToken(res.token);
    setUser(res.user);
    return null;
  }

  async function register(email: string, password: string, name: string): Promise<string | null> {
    const res = await authRegister(email, password, name);
    if (res.error || !res.token || !res.user) return res.error ?? "No se pudo crear la cuenta.";
    setAuthToken(res.token);
    setUser(res.user);
    return null;
  }

  function logout(): void {
    setAuthToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
}
