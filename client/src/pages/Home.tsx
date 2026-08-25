import { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AccountMenu from "../components/AccountMenu";
import { useEffect, useState } from "react";
import Button from "../components/Button";
import { detectMeetingPlatform, PLATFORM_REGISTRY } from "../lib/meetingPlatforms";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { CaptionsIcon, GlobeIcon, PeopleIcon, SparklesIcon } from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { getUnsavedMeeting } from "../lib/unsavedMeeting";
import { isStandalone } from "../pwa";
import { cardClass } from "../lib/ui";

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
  // El cartel AUTOMÁTICO del teléfono: si el permiso de lectura del
  // portapapeles ya fue dado (la primera vez que usaste "Pegar el enlace"),
  // al ABRIR la app se mira solo si hay un enlace de reunión copiado y el
  // cartel aparece sin tocar nada -- lo más cerca de la extensión de la PC
  // que un teléfono permite (ninguna app puede ver otras apps: regla de
  // Apple y de Google; acá sólo se mira el portapapeles, con permiso, al
  // abrir Unify). En iPhone la lectura sin gesto no existe: esto calla y
  // queda el botón de un toque. Un "Ahora no" se recuerda por enlace.
  const [copiadoDetectado, setCopiadoDetectado] = useState<{ url: string; nombre: string } | null>(null);
  useEffect(() => {
    let vivo = true;
    async function mirar(): Promise<void> {
      try {
        const permiso = await navigator.permissions?.query?.({ name: "clipboard-read" as PermissionName });
        if (permiso?.state !== "granted") return; // sin permiso previo: ni intentarlo
        const texto = (await navigator.clipboard.readText()).trim();
        if (!vivo || !texto || texto.length > 800) return;
        const det = detectMeetingPlatform(texto, { selfHosts: [window.location.hostname] });
        if (det.platform === "unknown" || det.platform === "encuentro" || !det.url) return;
        // El "Ahora no" se recuerda por el enlace NORMALIZADO (el mismo que
        // se guarda al descartar): el texto crudo puede variar en espacios.
        if (sessionStorage.getItem(`unify-vi:${det.url}`)) return;
        setCopiadoDetectado({ url: det.url, nombre: PLATFORM_REGISTRY[det.platform].label });
      } catch {
        /* iPhone (exige gesto), permiso revocado, o vacío: silencio */
      }
    }
    void mirar();
    const alVolver = () => { if (document.visibilityState === "visible") void mirar(); };
    document.addEventListener("visibilitychange", alVolver);
    return () => { vivo = false; document.removeEventListener("visibilitychange", alVolver); };
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

      {copiadoDetectado && (
        <div className="relative mx-5 mb-1 rounded-xl border border-brand-500/50 bg-brand-500/15 px-4 py-3 shadow-soft sm:mx-10">
          <p className="text-sm font-semibold text-strong">
            Uy, veo que copiaste un enlace de {copiadoDetectado.nombre}. ¿Entramos con Unify?
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button
              className="flex-1"
              onClick={() => navigate(`/externa?url=${encodeURIComponent(copiadoDetectado.url)}`)}
            >
              Entrar con subtítulos y grabación
            </Button>
            <button
              type="button"
              onClick={() => {
                try { sessionStorage.setItem(`unify-vi:${copiadoDetectado.url}`, "1"); } catch { /* sin storage */ }
                setCopiadoDetectado(null);
              }}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
            >
              Ahora no
            </button>
          </div>
        </div>
      )}
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
            Subtítulos, traducción y un asistente de IA en cada reunión
          </span>
          <h1 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight text-strong sm:text-6xl">
            Reuniones{" "}
            <span className="bg-gradient-to-r from-brand-400 to-brand-600 bg-clip-text text-transparent">
              sin barreras
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-300">
            Asigná roles, seguí cada palabra con subtítulos en vivo, entendé cualquier idioma al
            instante y dejá que la IA resuma lo importante. Nativo en Unify, o sumado a tus
            llamadas de Zoom, Teams y Meet.
          </p>

          <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3">
            <ActionCard
              highlight
              title="Crear una reunión"
              description="Definí roles para tu equipo y arrancá una reunión de Unify."
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
              description="Pegá el enlace de una reunión externa y usá las funciones de Unify encima."
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

          <ul className="mx-auto mt-14 grid max-w-3xl gap-4 text-left sm:grid-cols-2">
            <FeatureItem
              icon={<PeopleIcon className="h-5 w-5" />}
              title="Roles en vivo"
              description="El anfitrión asigna roles a cada persona durante la reunión, y cada frase queda anotada con quién la dijo."
            />
            <FeatureItem
              icon={<CaptionsIcon className="h-5 w-5" />}
              title="Subtítulos y traducción"
              description="Transcripción en vivo con nombre, traducida al instante al idioma que elija cada uno."
            />
            <FeatureItem
              icon={<SparklesIcon className="h-5 w-5" />}
              title="Asistente de IA"
              description="Preguntale a la IA durante la reunión: resúmenes, conclusiones y qué se dijo, en el momento."
            />
            <FeatureItem
              icon={<GlobeIcon className="h-5 w-5" />}
              title="Sobre otras plataformas"
              description="Llevá los subtítulos, la traducción y la IA a tus reuniones de Zoom, Teams o Jitsi."
            />
          </ul>
        </div>
      </main>

      {/* Pie con la puerta de entrada al soporte: visible sin buscarla. */}
      <footer className="relative mt-auto border-t border-ink-800 px-5 py-8 text-center">
        <p className="text-sm text-ink-300">¿Algo no te funcionó o tenés una duda?</p>
        <Link to="/soporte" className="mt-3 inline-block">
          <Button variant="secondary">Centro de ayuda y contacto</Button>
        </Link>
        <p className="mt-4 text-xs text-ink-500">
          <Link to="/privacidad" className="underline hover:text-ink-300">
            Política de privacidad
          </Link>
        </p>
      </footer>
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
      className={`flex flex-col ${cardClass} ${
        highlight ? "border-brand-500/60 ring-1 ring-brand-500/30" : ""
      }`}
    >
      <h2 className="text-lg font-semibold text-strong">{title}</h2>
      <p className="mt-1.5 flex-1 text-sm text-ink-300">{description}</p>
      {cta}
    </div>
  );
}

function FeatureItem({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className="flex gap-3 rounded-xl border border-ink-700 bg-ink-800 p-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">
        {icon}
      </span>
      <div>
        <p className="font-semibold text-strong">{title}</p>
        <p className="mt-1 text-sm text-ink-300">{description}</p>
      </div>
    </li>
  );
}
