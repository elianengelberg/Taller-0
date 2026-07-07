import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Logo from "../components/Logo";
import { setAuthToken } from "../lib/authToken";

// Landing spot for the Google OAuth redirect (see server's
// /api/auth/google/callback). It hands us a short-lived session token in the
// URL; we store it and bounce home. A full reload (not just navigate) so
// AuthProvider re-runs its startup check and picks up the new token cleanly.
export default function GoogleCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const token = params.get("token");
    if (token) {
      setAuthToken(token);
      window.location.replace("/");
    } else {
      navigate("/ingresar?googleError=1", { replace: true });
    }
  }, [params, navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink-950 px-6">
      <Logo />
      <p className="text-sm text-ink-300">Iniciando sesión…</p>
    </div>
  );
}
