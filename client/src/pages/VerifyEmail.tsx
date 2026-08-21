import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { confirmEmailVerification, confirmEmailWithCode, requestEmailVerification } from "../lib/api";
import { cardClass } from "../lib/ui";

// Donde aterriza el correo de verificación, por sus DOS caminos:
//
//  1. El enlace (#token=…). El token viene en el FRAGMENTO, no en la query:
//     los fragmentos nunca se mandan al servidor, así que no puede terminar en
//     los logs de Vercel ni en una cabecera Referer.
//  2. Los 6 dígitos escritos a mano. Es el caso real de todos los días: el
//     correo llega al teléfono y Unify está abierto en la computadora. Sin
//     esto, la persona tiene que reenviarse el mail a sí misma.
type State = "checking" | "code" | "done" | "already" | "error";

const LARGO = 6;

export default function VerifyEmail() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  // Qué token ya se canjeó. Es un ref y guarda el token (no un simple "ya
  // arranqué") por dos motivos: en desarrollo React monta dos veces, y sin
  // esto el segundo montaje volvería a canjear y mostraría "ya se usó" sobre
  // una verificación que acababa de salir bien; y si llega OTRO enlace por
  // cambio de fragmento, ese sí tiene que canjearse.
  const processed = useRef<string | null>(null);

  // --- Estado del formulario de código ---------------------------------------
  const [digitos, setDigitos] = useState<string[]>(Array(LARGO).fill(""));
  const [email, setEmail] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [reenviado, setReenviado] = useState<string | null>(null);
  const casillas = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (user?.email) setEmail((actual) => actual || user.email);
  }, [user?.email]);

  useEffect(() => {
    const run = () => {
      const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
      if (!token) {
        // Sin enlace no hay error: hay un formulario. Llegar acá a mano (o
        // desde "ya te mandamos el correo") tiene que servir para algo.
        if (processed.current === null) setState("code");
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

  async function enviarCodigo(codigo: string) {
    if (!email.trim()) {
      setError("Escribí el email con el que te registraste.");
      return;
    }
    setEnviando(true);
    setError(null);
    const res = await confirmEmailWithCode(email.trim(), codigo);
    setEnviando(false);
    if (res.error) {
      setError(res.error);
      // Se vacían las casillas y vuelve el foco al principio: reintentar tiene
      // que ser escribir, no borrar seis veces primero.
      setDigitos(Array(LARGO).fill(""));
      casillas.current[0]?.focus();
      return;
    }
    if (res.user) setUser(res.user);
    setState("done");
  }

  function escribir(indice: number, valor: string) {
    const limpio = valor.replace(/\D/g, "");
    if (!limpio) {
      // Borrar dentro de la casilla.
      setDigitos((prev) => prev.map((d, i) => (i === indice ? "" : d)));
      return;
    }
    // Pegar el código entero desde el correo cae acá: se reparte solo.
    const siguientes = [...digitos];
    for (let i = 0; i < limpio.length && indice + i < LARGO; i++) {
      siguientes[indice + i] = limpio[i];
    }
    setDigitos(siguientes);
    const proximo = Math.min(indice + limpio.length, LARGO - 1);
    casillas.current[proximo]?.focus();
    const completo = siguientes.join("");
    // Con los 6 dígitos puestos, se envía solo: pedir además un clic en un
    // botón es un paso que nadie entiende para qué está.
    if (completo.length === LARGO && !completo.includes("")) void enviarCodigo(completo);
  }

  function teclas(indice: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digitos[indice] && indice > 0) {
      casillas.current[indice - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && indice > 0) casillas.current[indice - 1]?.focus();
    if (e.key === "ArrowRight" && indice < LARGO - 1) casillas.current[indice + 1]?.focus();
  }

  async function reenviar() {
    setReenviado(null);
    setError(null);
    const res = await requestEmailVerification(email.trim() || undefined);
    setReenviado(
      res.error
        ? res.error
        : "Listo: si esa dirección tiene una cuenta sin confirmar, el código nuevo ya salió."
    );
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
        <div className={`${cardClass} pop-enter text-center`}>
          {state === "checking" && (
            <>
              <h1 className="text-2xl font-bold text-strong">Confirmando tu email…</h1>
              <p className="mt-2 text-sm text-ink-300">Un segundo.</p>
            </>
          )}

          {state === "code" && (
            <>
              <h1 className="text-2xl font-bold text-strong">Escribí tu código</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">
                Te mandamos un correo con un código de 6 dígitos. Escribilo acá — o tocá el botón del
                correo, que hace lo mismo.
              </p>

              {!user?.email && (
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  autoComplete="email"
                  className="mt-5 w-full rounded-xl border border-ink-600 bg-ink-800 px-4 py-3 text-sm text-strong placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
                />
              )}

              {/* Seis casillas, no un campo largo: se ve cuántos dígitos faltan
                  y en el teléfono sale el teclado numérico. */}
              <div className="mt-5 flex justify-center gap-2" dir="ltr">
                {digitos.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      casillas.current[i] = el;
                    }}
                    value={d}
                    onChange={(e) => escribir(i, e.target.value)}
                    onKeyDown={(e) => teclas(i, e)}
                    onFocus={(e) => e.target.select()}
                    inputMode="numeric"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    maxLength={LARGO}
                    aria-label={`Dígito ${i + 1} de ${LARGO}`}
                    disabled={enviando}
                    className="h-14 w-11 rounded-xl border border-ink-600 bg-ink-800 text-center text-2xl font-bold text-strong caret-brand-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-60 sm:w-12"
                  />
                ))}
              </div>

              {enviando && <p className="mt-4 text-sm text-ink-300">Confirmando…</p>}
              {error && (
                <p
                  role="alert"
                  className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300"
                >
                  {error}
                </p>
              )}
              {reenviado && <p className="mt-4 text-sm text-emerald-300">{reenviado}</p>}

              <p className="mt-5 text-sm text-ink-400">
                ¿No te llegó?{" "}
                <button type="button" onClick={reenviar} className="font-semibold text-brand-300 underline">
                  Mandar otro código
                </button>
              </p>
              <p className="mt-2 text-xs text-ink-500">
                Mirá también en Spam o en la pestaña “Promociones”. El código vence a las 24 horas.
              </p>
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
                Los enlaces vencen a las 24 horas y sirven una sola vez. Probá con el código de 6
                dígitos del correo, o pedí uno nuevo.
              </p>
              <Button
                className="mt-6 w-full"
                onClick={() => {
                  setError(null);
                  setState("code");
                }}
              >
                Escribir el código
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
