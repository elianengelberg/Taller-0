import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { claimMeeting } from "../lib/api";
import { clearUnsavedMeeting } from "../lib/unsavedMeeting";
import { cardClass, inputClass, labelClass } from "../lib/ui";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  // Where to go back to after logging in (set by the protected-route redirect),
  // falling back to the history page.
  const state = location.state as { from?: string; claimMeetingId?: string } | null;
  // Default landing spot after logging in is the home page -- "from" only
  // overrides it when we were actually bounced here from a protected route
  // (e.g. RequireAuth sending someone back to /historial).
  const from = state?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    const err = await login(email.trim(), password);
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    // Arrived here from the post-call "save this meeting?" prompt -- attach
    // the guest meeting to this account now that we're logged in.
    if (state?.claimMeetingId) {
      void claimMeeting(state.claimMeetingId).then(() => clearUnsavedMeeting());
    }
    navigate(state?.claimMeetingId ? "/historial" : from, { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="inline-block">
          <Logo className="mb-8" />
        </Link>
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-white">Iniciar sesión</h1>
          <p className="mt-1 text-sm text-ink-300">
            Entrá a tu cuenta para ver tu historial de reuniones.
          </p>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className={labelClass} htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className={inputClass}
                placeholder="vos@ejemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="password">
                Contraseña
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting || !email.trim() || !password}>
              {submitting ? "Entrando…" : "Iniciar sesión"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-300">
            ¿No tenés cuenta?{" "}
            <Link to="/registrarse" className="font-semibold text-brand-300 hover:text-brand-200">
              Crear una cuenta
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
