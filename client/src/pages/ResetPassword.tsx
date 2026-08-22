import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { confirmPasswordReset } from "../lib/api";
import { cardClass, inputClass, labelClass } from "../lib/ui";

// Donde aterriza el enlace de "recuperar contraseña". El token viaja en el
// fragmento y se saca de la barra de direcciones apenas se lee.
//
// El enlace NO se canjea al abrir la página: se canjea recién al enviar la
// contraseña nueva. Así, el escáner de enlaces que tienen muchos correos de
// trabajo puede abrir esta página sin quemar el enlace.
export default function ResetPassword() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  // `undefined` = todavía no se leyó el fragmento; `null` = se leyó y no había
  // token. La diferencia importa: sin ella, el primer render mostraría el
  // formulario un instante incluso cuando el enlace viene roto.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Se escucha `hashchange` además de leer al montar. Cambiar sólo el
  // fragmento NO recarga la página ni vuelve a montar el componente: si
  // alguien ya está en esta pantalla (por ejemplo, viendo "el enlace está
  // incompleto") y abre el enlace bueno desde el correo en la misma pestaña,
  // sin esto el token no se leería nunca -- y encima quedaría a la vista en la
  // barra de direcciones, que es justo lo que el fragmento venía a evitar.
  useEffect(() => {
    const read = () => {
      const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
      if (fromHash) {
        history.replaceState(null, "", window.location.pathname);
        setToken(fromHash);
        return;
      }
      // Sin token: "no hay" sólo la primera vez. Si ya se había leído uno, el
      // hash vacío es obra del replaceState de arriba, no un enlace roto.
      setToken((prev) => (prev == null ? null : prev));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || password.length < 8) return;
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await confirmPasswordReset(token, password);
    setSubmitting(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (res.user) setUser(res.user);
    setDone(true);
  }

  const missingToken = token === null;

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
          {done ? (
            <>
              <h1 className="text-2xl font-bold text-strong">Contraseña actualizada</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-300">
                Ya estás dentro de tu cuenta. Cerramos las sesiones que hubiera abiertas en otros
                dispositivos: si alguien más había entrado, quedó afuera.
              </p>
              <Button className="mt-6 w-full" onClick={() => navigate("/", { replace: true })}>
                Ir a Unify
              </Button>
            </>
          ) : missingToken ? (
            <>
              <h1 className="text-2xl font-bold text-strong">Ese enlace está incompleto</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-300">
                Abrilo desde el correo tal cual te llegó, sin copiar sólo una parte. Si ya venció,
                pedí uno nuevo.
              </p>
              <Link to="/recuperar">
                <Button variant="secondary" className="mt-6 w-full">
                  Pedir un enlace nuevo
                </Button>
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-strong">Elegí una contraseña nueva</h1>
              <p className="mt-1 text-sm text-ink-300">
                Al guardarla se cierran todas las sesiones abiertas de tu cuenta.
              </p>

              <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
                <div>
                  <label className={labelClass} htmlFor="new-password">
                    Nueva contraseña
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    className={inputClass}
                    placeholder="Al menos 8 caracteres"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {password.length > 0 && password.length < 8 && (
                    <p className="mt-1.5 text-xs text-brand-300">
                      La contraseña debe tener al menos 8 caracteres.
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelClass} htmlFor="confirm-new-password">
                    Repetila
                  </label>
                  <input
                    id="confirm-new-password"
                    type="password"
                    autoComplete="new-password"
                    className={inputClass}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>

                {error && (
                  <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || password.length < 8 || !confirm}
                >
                  {submitting ? "Guardando…" : "Guardar contraseña"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
