import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { requestPasswordReset } from "../lib/api";
import { cardClass, inputClass, labelClass } from "../lib/ui";

// "Olvidé mi contraseña".
//
// La pantalla dice lo mismo exista o no la cuenta, y no es por vaguedad: si
// dijera "no hay ninguna cuenta con ese email", cualquiera podría usar este
// formulario para averiguar quién está registrado en Unify. El servidor
// responde igual para todos por el mismo motivo.
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    const res = await requestPasswordReset(email.trim());
    setSubmitting(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSent(true);
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 py-10">
      <GradientBackdrop />
      <div className="relative w-full max-w-md">
        {/* El logo lleva al inicio, pero nadie lo sabe: hay que VER un botón
            que lo diga. Sin esto, quien abre "iniciar sesión" por error queda
            sin salida visible y usa el botón atrás del navegador (o se va). */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <Link to="/" aria-label="Ir al inicio">
            <Logo tagline />
          </Link>
          <Link
            to="/"
            className="text-sm font-medium text-ink-300 underline-offset-4 hover:text-strong hover:underline"
          >
            ← Volver al inicio
          </Link>
        </div>
        <div className={`${cardClass} pop-enter`}>
          {sent ? (
            <>
              <h1 className="text-2xl font-bold text-strong">Revisá tu correo</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-300">
                Si hay una cuenta con <span className="font-medium text-strong">{email.trim()}</span>,
                le mandamos un enlace para elegir una contraseña nueva. Vence en una hora y sirve una
                sola vez.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-400">
                ¿No llega? Fijate en el correo no deseado. Y si creaste la cuenta con “Continuar con
                Google”, no tenés contraseña que recuperar: el correo que te llega te lo explica.
              </p>
              <Link to="/ingresar">
                <Button variant="secondary" className="mt-6 w-full">
                  Volver a iniciar sesión
                </Button>
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-strong">Recuperar tu contraseña</h1>
              <p className="mt-1 text-sm text-ink-300">
                Escribí tu email y te mandamos un enlace para elegir una nueva.
              </p>

              <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
                <div>
                  <label className={labelClass} htmlFor="reset-email">
                    Email
                  </label>
                  <input
                    id="reset-email"
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

                {error && (
                  <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={submitting || !email.trim()}>
                  {submitting ? "Enviando…" : "Enviarme el enlace"}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-ink-300">
                <Link to="/ingresar" className="font-semibold text-brand-300 hover:text-brand-200">
                  Volver a iniciar sesión
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
