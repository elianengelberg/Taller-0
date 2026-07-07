import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GoogleButton from "../components/GoogleButton";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { claimMeeting } from "../lib/api";
import { clearUnsavedMeeting } from "../lib/unsavedMeeting";
import { cardClass, inputClass, labelClass } from "../lib/ui";

export default function Register() {
  const navigate = useNavigate();
  const location = useLocation();
  const { register } = useAuth();
  const state = location.state as { from?: string; claimMeetingId?: string } | null;
  // Default landing spot after registering is the home page -- "from" only
  // overrides it when we were actually bounced here from a protected route
  // (e.g. RequireAuth sending someone back to /historial).
  const from = state?.from ?? "/";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordTooShort = password.length > 0 && password.length < 8;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 8) return;
    setSubmitting(true);
    setError(null);
    const err = await register(email.trim(), password, name.trim());
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
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
          <h1 className="text-2xl font-bold text-white">Crear una cuenta</h1>
          <p className="mt-1 text-sm text-ink-300">
            Con tu cuenta guardás el historial de tus reuniones, privado y solo tuyo.
          </p>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className={labelClass} htmlFor="name">
                Nombre
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                className={inputClass}
                placeholder="Tu nombre"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
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
                autoComplete="new-password"
                className={inputClass}
                placeholder="Al menos 8 caracteres"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {passwordTooShort && (
                <p className="mt-1.5 text-xs text-brand-300">La contraseña debe tener al menos 8 caracteres.</p>
              )}
            </div>

            {error && (
              <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !name.trim() || !email.trim() || password.length < 8}
            >
              {submitting ? "Creando…" : "Crear cuenta"}
            </Button>
          </form>

          <GoogleButton />

          <p className="mt-6 text-center text-sm text-ink-300">
            ¿Ya tenés cuenta?{" "}
            <Link to="/ingresar" className="font-semibold text-brand-300 hover:text-brand-200">
              Iniciar sesión
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
