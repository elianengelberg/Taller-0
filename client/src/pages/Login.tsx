import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import GoogleButton from "../components/GoogleButton";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { claimMeeting, fetchAuthConfig, requestEmailVerification } from "../lib/api";
import { clearUnsavedMeeting } from "../lib/unsavedMeeting";
import { cardClass, inputClass, labelClass } from "../lib/ui";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
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
  const [error, setError] = useState<string | null>(
    searchParams.get("googleError") ? "No se pudo iniciar sesión con Google. Probá de nuevo." : null
  );
  const [submitting, setSubmitting] = useState(false);
  // La contraseña era correcta pero falta abrir el enlace del correo. Es un
  // estado aparte porque no se arregla escribiendo otra cosa en el formulario.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resent, setResent] = useState<string | null>(null);
  // "Olvidé mi contraseña" sólo se ofrece si este servidor puede mandar el
  // correo. Si no, llevaría a una pantalla que nunca va a recibir nada.
  const [resetEnabled, setResetEnabled] = useState(false);
  useEffect(() => {
    fetchAuthConfig().then((c) => setResetEnabled(c.passwordReset));
  }, []);

  async function handleResend() {
    setResent(null);
    const res = await requestEmailVerification(email.trim());
    setResent(
      res.error ?? `Listo, te lo mandamos de nuevo a ${email.trim()}. Puede tardar un par de minutos.`
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    setNeedsVerification(false);
    setResent(null);
    const err = await login(email.trim(), password);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      setNeedsVerification(err.needsVerification);
      return;
    }
    // Arrived here from the post-call "save this meeting?" prompt -- attach
    // the guest meeting to this account now that we're logged in. AWAIT it so
    // the history we land on already contains it, and only forget the local
    // pointer if it actually worked: a meeting that already has another owner
    // (e.g. someone logged-in joined that external room first) can't be
    // claimed, and silently clearing it would lose it with a false "saved".
    if (state?.claimMeetingId) {
      const claimed = await claimMeeting(state.claimMeetingId);
      if (claimed) clearUnsavedMeeting();
      navigate("/historial", { replace: true, state: claimed ? undefined : { claimFailed: true } });
      return;
    }
    navigate(from, { replace: true });
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 py-10">
      <GradientBackdrop />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link to="/" aria-label="Ir al inicio">
            <Logo tagline />
          </Link>
        </div>
        <div className={`${cardClass} pop-enter`}>
          <h1 className="text-2xl font-bold text-strong">Iniciar sesión</h1>
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
              <div
                className={`rounded-xl border px-4 py-2.5 text-sm ${
                  needsVerification
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-red-500/40 bg-red-500/10 text-red-300"
                }`}
              >
                <p>{error}</p>
                {needsVerification && (
                  <>
                    <button
                      type="button"
                      onClick={handleResend}
                      className="mt-2 font-semibold underline underline-offset-2 hover:text-amber-100"
                    >
                      Volver a enviarme el enlace
                    </button>
                    {resent && <p className="mt-2 text-xs text-amber-200/80">{resent}</p>}
                  </>
                )}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting || !email.trim() || !password}>
              {submitting ? "Entrando…" : "Iniciar sesión"}
            </Button>
          </form>

          {resetEnabled && (
            <p className="mt-4 text-center text-sm">
              <Link to="/recuperar" className="text-ink-300 hover:text-brand-200">
                ¿Olvidaste tu contraseña?
              </Link>
            </p>
          )}

          <GoogleButton />

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
