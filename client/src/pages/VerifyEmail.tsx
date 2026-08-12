import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { confirmEmailVerification } from "../lib/api";
import { cardClass } from "../lib/ui";

// Donde aterriza el enlace del correo de verificación.
//
// El token viene en el FRAGMENTO (#token=…), no en la query: los fragmentos
// nunca se mandan al servidor, así que no puede terminar en los logs de Vercel
// ni en una cabecera Referer. Mismo criterio que el redirect de Google.
type State = "checking" | "done" | "already" | "error";

export default function VerifyEmail() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  // Qué token ya se canjeó. Es un ref y guarda el token (no un simple "ya
  // arranqué") por dos motivos: en desarrollo React monta dos veces, y sin
  // esto el segundo montaje volvería a canjear y mostraría "ya se usó" sobre
  // una verificación que acababa de salir bien; y si llega OTRO enlace por
  // cambio de fragmento, ese sí tiene que canjearse.
  const processed = useRef<string | null>(null);

  useEffect(() => {
    const run = () => {
      const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
      if (!token) {
        // Sólo es un enlace roto si nunca hubo token: el hash vacío después de
        // canjear lo dejó el replaceState de acá abajo.
        if (processed.current === null) {
          setState("error");
          setError("Ese enlace está incompleto. Abrilo desde el correo, sin copiar sólo una parte.");
        }
        return;
      }
      if (processed.current === token) return;
      processed.current = token;
      // Se limpia enseguida: si la persona deja la pestaña abierta o comparte
      // la URL, el token no queda a la vista en la barra de direcciones.
      history.replaceState(null, "", window.location.pathname);
      setState("checking");
      confirmEmailVerification(token).then((res) => {
        if (res.error) {
          setState("error");
          setError(res.error);
          return;
        }
        if (res.alreadyVerified) {
          setState("already");
          return;
        }
        if (res.user) setUser(res.user);
        setState("done");
      });
    };
    run();
    // Cambiar sólo el fragmento no recarga la página: sin esto, abrir el
    // enlace del correo estando ya en esta pantalla no haría nada.
    window.addEventListener("hashchange", run);
    return () => window.removeEventListener("hashchange", run);
  }, [setUser]);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 py-10">
      <GradientBackdrop />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link to="/" aria-label="Ir al inicio">
            <Logo tagline />
          </Link>
        </div>
        <div className={`${cardClass} pop-enter text-center`}>
          {state === "checking" && (
            <>
              <h1 className="text-2xl font-bold text-strong">Confirmando tu email…</h1>
              <p className="mt-2 text-sm text-ink-300">Un segundo.</p>
            </>
          )}

          {state === "done" && (
            <>
              <h1 className="text-2xl font-bold text-strong">¡Listo! Tu email quedó confirmado</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">
                Ya podés entrar a Unify desde cualquier dispositivo. Tu historial de reuniones es
                privado y sólo se abre con tu cuenta.
              </p>
              <Button className="mt-6 w-full" onClick={() => navigate("/", { replace: true })}>
                Ir a Unify
              </Button>
            </>
          )}

          {state === "already" && (
            <>
              <h1 className="text-2xl font-bold text-strong">Ese email ya estaba confirmado</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">
                No hay nada más que hacer: iniciá sesión con tu cuenta.
              </p>
              <Button className="mt-6 w-full" onClick={() => navigate("/ingresar", { replace: true })}>
                Iniciar sesión
              </Button>
            </>
          )}

          {state === "error" && (
            <>
              <h1 className="text-2xl font-bold text-strong">No pudimos confirmar el email</h1>
              <p className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-300">
                Los enlaces vencen a las 24 horas y sirven una sola vez. Iniciá sesión y te mandamos
                uno nuevo.
              </p>
              <Button className="mt-6 w-full" onClick={() => navigate("/ingresar", { replace: true })}>
                Ir a iniciar sesión
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
