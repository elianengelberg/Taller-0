import { ReactNode, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AccountMenu from "../components/AccountMenu";
import { useState } from "react";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { CaptionsIcon, GlobeIcon, PeopleIcon, SparklesIcon } from "../components/icons";
import { AppMockupDesktop } from "../components/AppMockup";
import { useAuth } from "../context/AuthContext";
import { getUnsavedMeeting } from "../lib/unsavedMeeting";
import { isStandalone } from "../pwa";

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  // El cartel de "te estás uniendo a una reunión" en el TELÉFONO y el iPad:
  // ahí no hay extensiones (regla de Google y de Apple), así que el enlace
  // tiene que llegar a Unify de la forma más corta posible. Un toque: se lee
  // el portapapeles (el navegador pide permiso, y en iPhone muestra su
  // "¿Pegar?" -- ese gesto ES el consentimiento) y si hay un enlace, directo
  // a la pantalla de detección con todo armado. Si no se puede leer o no hay
  // nada, nunca es un callejón: queda el campo de pegar a mano.
  const [pegando, setPegando] = useState<"" | "sin-enlace">("");

  // ¿Esta pantalla YA corre adentro de la app instalada? (la PWA a pantalla
  // completa, o la ventana de la app de escritorio -- Electron se delata en
  // el user agent). El botón "Instalar Unify" ahí es una trampa: te manda a
  // instalar lo que ya estás usando. Se deja el botón (sirve para instalar
  // en OTRO aparato) pero con la verdad al lado.
  const enLaApp = isStandalone() || /Electron/i.test(navigator.userAgent);
  const [estadoApp, setEstadoApp] = useState<"ultima" | "vieja" | null>(null);
  useEffect(() => {
    if (!enLaApp) return;
    let vivo = true;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (!reg) {
          if (vivo) setEstadoApp("ultima"); // sin service worker no hay "vieja" posible
          return;
        }
        // Se le pregunta al servidor si hay algo más nuevo (con tope: esta
        // consulta jamás puede colgar la portada) y se mira si quedó una
        // versión esperando. No se aplica nada desde acá: sólo se dice.
        await Promise.race([reg.update().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
        if (vivo) setEstadoApp(reg.waiting ? "vieja" : "ultima");
      } catch {
        if (vivo) setEstadoApp("ultima");
      }
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function pegarEnlace(): Promise<void> {
    let texto = "";
    try {
      texto = (await navigator.clipboard.readText()).trim();
    } catch {
      navigate("/externa");
      return;
    }
    if (texto && /https?:\/\//.test(texto)) {
      navigate(`/externa?url=${encodeURIComponent(texto)}`);
      return;
    }
    if (texto) {
      // Copió algo que no es un enlace (un código, una invitación con texto):
      // que la pantalla de externa lo intente igual, sabe leer invitaciones.
      navigate(`/externa?text=${encodeURIComponent(texto.slice(0, 500))}`);
      return;
    }
    setPegando("sin-enlace");
    setTimeout(() => setPegando(""), 2500);
  }
  // One-shot notice from a meeting exit (kicked, meeting ended for all).
  const notice = (location.state as { notice?: string } | null)?.notice ?? null;
  const { user } = useAuth();
  // A guest who skipped the post-call save prompt gets a second chance here,
  // on their next visit -- see SaveMeetingPrompt / unsavedMeeting.ts.
  const unsaved = !user ? getUnsavedMeeting() : null;

  return (
    <div className="relative flex min-h-screen flex-col bg-ink-950">
      <GradientBackdrop />
      <header className="relative flex items-center justify-between gap-3 px-5 py-5 sm:px-10 sm:py-6">
        <Logo />
        <div className="flex items-center gap-4 sm:gap-6">
          {/* Ya usando la app instalada, "Instalar" no tiene sentido: ese
              enlace es para quien entra por la web. (La página sigue estando
              en /instalar, enlazada desde el pie, porque la EXTENSIÓN se
              instala aparte y desde ahí se ve si está.) */}
          {!isStandalone() && (
            <Link
              to="/instalar"
              className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong"
            >
              Instalar
            </Link>
          )}
          <Link
            to="/historial"
            className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong"
          >
            Historial
          </Link>
          <AccountMenu />
        </div>
      </header>

      {notice && (
        <div className="relative mx-5 mb-1 rounded-xl border border-ink-600 bg-ink-800 px-4 py-3 text-center text-sm text-strong shadow-soft sm:mx-10">
          {notice}
        </div>
      )}
      {!user && (
        <div className="relative mx-5 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-3 text-center text-sm text-brand-200 sm:mx-10">
          {unsaved ? (
            <>
              Tenés una reunión reciente sin guardar.{" "}
              <Link to="/ingresar" state={{ claimMeetingId: unsaved.dbId }} className="font-semibold underline">
                Iniciá sesión
              </Link>{" "}
              o{" "}
              <Link to="/registrarse" state={{ claimMeetingId: unsaved.dbId }} className="font-semibold underline">
                creá una cuenta
              </Link>{" "}
              para guardarla en tu historial antes de que se pierda.
            </>
          ) : (
            <>
              <Link to="/ingresar" className="font-semibold underline">
                Iniciá sesión
              </Link>{" "}
              o{" "}
              <Link to="/registrarse" className="font-semibold underline">
                creá una cuenta
              </Link>{" "}
              para guardar el historial de tus reuniones.
            </>
          )}
        </div>
      )}

      <main className="relative flex flex-1 flex-col items-center px-6 pb-20 pt-6">
        <div className="w-full max-w-4xl text-center">
          <span className="inline-block rounded-full bg-brand-500/15 px-4 py-1.5 text-sm font-medium text-brand-300">
            Tus reuniones: grabadas, traducidas y resumidas solas
          </span>
          <h1 className="mt-6 font-display text-5xl font-extrabold uppercase leading-[0.92] tracking-tight text-strong sm:text-7xl">
            Reuniones<br />
            <span className="bg-gradient-to-r from-sky-400 via-brand-500 to-indigo-500 bg-clip-text text-transparent">
              sin barreras
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-300">
            Entrá a cualquier reunión y listo: subtítulos, traducción y un resumen al final.
          </p>

          <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3">
            <ActionCard
              highlight
              title="Crear una reunión"
              description="Armá una sala acá en Unify y pasale el código a tu equipo."
              cta={
                <Button className="mt-5 w-full" onClick={() => navigate("/crear")}>
                  Crear reunión
                </Button>
              }
            />
            <ActionCard
              highlight
              title="Tengo un código"
              description="Sumate a una reunión de Unify que ya está en marcha."
              cta={
                <Button variant="secondary" className="mt-5 w-full" onClick={() => navigate("/unirse")}>
                  Unirme con código
                </Button>
              }
            />
            <ActionCard
              highlight
              title="Zoom · Teams · Meet"
              description="¿Te mandaron un link de reunión? Pegalo acá y sumale subtítulos, traducción y grabación."
              cta={
                <>
                  <Button className="mt-5 w-full" onClick={() => void pegarEnlace()}>
                    {pegando === "sin-enlace" ? "No había un enlace copiado" : "Pegar el enlace que me mandaron"}
                  </Button>
                  {/* El plan B a la vista: si el portapapeles no se puede
                      leer (permiso denegado, navegador que no deja), la misma
                      pantalla de siempre con el campo para pegar a mano. */}
                  <button
                    type="button"
                    onClick={() => navigate("/externa")}
                    className="mt-2.5 w-full rounded-lg px-3 py-2.5 text-sm font-medium text-ink-300 underline-offset-2 hover:text-ink-100 hover:underline"
                  >
                    o escribirlo a mano
                  </button>
                </>
              }
            />
          </div>

          {/* Las cuatro cosas que hace Unify, presentadas en un "bento":
              baldosas de tamaños distintos (dos anchas, dos chicas) con un
              brillo de color propio. Misma información que antes, pero con un
              ritmo visual en vez de una grilla pareja. */}
          <div className="mt-20">
            <h2 className="font-display text-3xl font-extrabold uppercase tracking-tight text-strong sm:text-4xl">
              Todo lo que pasa en la reunión, resuelto
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-ink-300">
              Sin instalar nada raro ni tomar notas. Vos hablás, Unify se encarga del resto.
            </p>
            <div className="mx-auto mt-8 grid max-w-4xl gap-4 text-left sm:grid-cols-3">
              <Feature
                wide
                glow="bg-brand-500/25"
                chip="bg-brand-500/15 text-brand-300"
                icon={<CaptionsIcon className="h-6 w-6" />}
                title="Subtítulos y traducción"
                description="Transcripción en vivo con el nombre de quien habla, traducida al instante al idioma que elija cada uno."
              />
              <Feature
                glow="bg-sky-500/25"
                chip="bg-sky-500/15 text-sky-300"
                icon={<PeopleIcon className="h-6 w-6" />}
                title="Roles en vivo"
                description="El anfitrión asigna roles en la reunión y cada frase queda anotada con quién la dijo."
              />
              <Feature
                glow="bg-violet-500/25"
                chip="bg-violet-500/15 text-violet-300"
                icon={<SparklesIcon className="h-6 w-6" />}
                title="Asistente de IA"
                description="Preguntale a la IA en plena reunión: resúmenes, conclusiones y qué se dijo, al momento."
              />
              <Feature
                wide
                glow="bg-indigo-500/25"
                chip="bg-indigo-500/15 text-indigo-300"
                icon={<GlobeIcon className="h-6 w-6" />}
                title="Sobre otras plataformas"
                description="Llevá los subtítulos, la traducción y la IA a tus reuniones de Zoom, Teams o Jitsi."
              />
            </div>
          </div>

          {/* Mostrar el producto (estilo Discord): título display grande a un
              lado, la maqueta de Unify sobre un blob de color al otro. */}
          <div className="mx-auto mt-24 grid max-w-5xl items-center gap-10 text-left lg:grid-cols-2">
            <div>
              <h2 className="font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-strong sm:text-5xl">
                Todo lo que se dijo,<br />ordenado y buscable
              </h2>
              <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-300">
                El video con la transcripción que corre palabra por palabra, el resumen automático,
                y una IA que responde sobre cualquier reunión. Sin tomar una sola nota.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button onClick={() => navigate("/instalar")}>Instalar Unify</Button>
                {enLaApp && estadoApp === "ultima" && (
                  <span className="text-xs font-semibold text-red-400">
                    Ya lo instalaste — estás en la última versión.
                  </span>
                )}
                {enLaApp && estadoApp === "vieja" && (
                  <span className="text-xs font-semibold text-red-400">
                    Ya lo instalaste, pero hay una versión más nueva: entrá y tocá «Buscar
                    actualización».
                  </span>
                )}
              </div>
            </div>
            <AppMockupDesktop />
          </div>
        </div>

        {/* Banda de cierre estilo Discord: fondo de color, título enorme y un
            botón pill grande. Cierra la landing antes del pie. */}
        <div className="relative mt-24 w-full overflow-hidden">
          <div className="mx-auto max-w-5xl rounded-[2.5rem] bg-gradient-to-br from-brand-600 to-indigo-600 px-8 py-16 text-center shadow-lg sm:px-16">
            <h2 className="font-display text-4xl font-extrabold uppercase leading-tight tracking-tight text-white sm:text-5xl">
              Probalo en tu próxima reunión
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-white/80">
              Gratis, sin tarjeta. Creá una reunión o sumate a una externa y ya tenés subtítulos,
              traducción y resumen.
            </p>
            {/* Acciones de USAR, no de instalar: quien llegó hasta acá quiere
                probarlo -- y quien lee esto desde la app ya lo tiene puesto. */}
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => navigate("/crear")}
                className="rounded-full bg-white px-8 py-3.5 text-base font-bold text-brand-700 shadow-md transition-transform hover:-translate-y-0.5"
              >
                Crear una reunión
              </button>
              <button
                type="button"
                onClick={() => navigate("/externa")}
                className="rounded-full bg-white/15 px-8 py-3.5 text-base font-bold text-white ring-1 ring-white/30 transition-colors hover:bg-white/25"
              >
                Unirme a una reunión externa
              </button>
            </div>
          </div>
        </div>
      </main>
      {/* El pie de página global (Footer, montado por ConPie en App.tsx)
          reemplaza al que vivía acá: una sola barra de soporte en todo el
          sitio. */}
    </div>
  );
}

function ActionCard({
  title,
  description,
  cta,
  highlight,
}: {
  title: string;
  description: string;
  cta: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded-3xl border border-ink-700 bg-ink-800 p-6 text-left shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-lg ${
        highlight ? "ring-1 ring-brand-500/30" : ""
      }`}
    >
      <h2 className="text-lg font-bold text-strong">{title}</h2>
      <p className="mt-1.5 flex-1 text-sm leading-relaxed text-ink-300">{description}</p>
      {cta}
    </div>
  );
}

// Una baldosa del "bento". `wide` la hace ocupar dos columnas (y pone el ícono
// al lado del texto en pantallas grandes); `glow` es el brillo de color en la
// esquina y `chip` el color del ícono. Así cada una tiene su acento propio.
function Feature({
  icon,
  title,
  description,
  glow,
  chip,
  wide,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  glow: string;
  chip: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-3xl border border-ink-700 bg-ink-800 p-6 shadow-soft transition-transform duration-200 hover:-translate-y-1 ${
        wide ? "sm:col-span-2 sm:p-7" : ""
      }`}
    >
      {/* Brillo de color en la esquina, la firma de cada baldosa. */}
      <div aria-hidden className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-2xl ${glow}`} />
      <div className={`relative ${wide ? "sm:flex sm:items-start sm:gap-5" : ""}`}>
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${chip}`}>
          {icon}
        </span>
        <div className={wide ? "mt-4 sm:mt-0" : "mt-4"}>
          <h3 className="text-lg font-bold text-strong">{title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-300">{description}</p>
        </div>
      </div>
    </div>
  );
}
