import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { canPromptInstall, isStandalone, promptInstall } from "../pwa";
import { cardClass } from "../lib/ui";

// El centro de instalación: TODO Unify se instala desde esta página.
//
//  1. La app (PWA): un clic donde el navegador lo permite (Chrome/Edge,
//     escritorio y Android); pasos por plataforma donde no (iOS, Firefox).
//  2. La extensión: el ZIP que sirve esta misma web -- generado en cada
//     build, siempre la última versión -- o la Chrome Web Store cuando esté
//     publicada (basta con completar CHROME_WEB_STORE_URL acá abajo).

// Al publicar en la Chrome Web Store, pegá acá la URL de la ficha
// (https://chromewebstore.google.com/detail/…). Con esto puesto, el botón
// principal pasa a ser "Agregar a Chrome" y el ZIP queda como alternativa.
const CHROME_WEB_STORE_URL = "";

type Plataforma = "android" | "ios" | "escritorio";

function detectarPlataforma(): Plataforma {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "escritorio";
}

export default function Instalar() {
  const [instalable, setInstalable] = useState(canPromptInstall());
  const [instalada, setInstalada] = useState(isStandalone());
  const [estado, setEstado] = useState<string | null>(null);
  const plataforma = detectarPlataforma();

  useEffect(() => {
    // El evento puede llegar después de montar esta página.
    const onInstalable = () => setInstalable(true);
    const onInstalada = () => {
      setInstalada(true);
      setEstado(null);
    };
    window.addEventListener("unify:instalable", onInstalable);
    window.addEventListener("appinstalled", onInstalada);
    return () => {
      window.removeEventListener("unify:instalable", onInstalable);
      window.removeEventListener("appinstalled", onInstalada);
    };
  }, []);

  async function handleInstalar() {
    setEstado(null);
    const ok = await promptInstall();
    setInstalable(canPromptInstall());
    if (ok) setEstado("¡Listo! Unify quedó instalada: buscala con las apps de tu dispositivo.");
    else setEstado("No hay problema — podés instalarla cuando quieras desde esta página.");
  }

  return (
    <div className="relative min-h-screen bg-ink-950 px-4 py-10 sm:px-6">
      <GradientBackdrop />
      <div className="relative mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between gap-3">
          <Link to="/" aria-label="Ir al inicio">
            <Logo />
          </Link>
          <Link to="/" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong">
            Volver al inicio
          </Link>
        </div>

        <h1 className="text-3xl font-bold text-strong">Instalar Unify</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">
          Dos piezas, cada una con su trabajo: la <span className="font-semibold text-strong">app</span> para
          crear y unirte a reuniones desde su propio ícono, y la{" "}
          <span className="font-semibold text-strong">extensión</span> que vigila por vos — cuando entrás a un
          Zoom, Meet, Teams o Jitsi, te ofrece subtítulos y grabación ahí mismo, y si no respondés arranca sola
          con los subtítulos a los 5 segundos.
        </p>

        {/* ── 1. La app ─────────────────────────────────────────────── */}
        <section className={`${cardClass} mt-6`}>
          <h2 className="text-lg font-semibold text-strong">1 · La app de Unify</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-300">
            Se instala desde esta misma página — sin tiendas ni descargas. Queda con su ícono, se abre sola en
            su ventana, y en Android aparece en el menú Compartir: un enlace de reunión que te llega por
            WhatsApp se abre en Unify ya detectado.
          </p>

          {instalada ? (
            <p className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
              Ya estás usando Unify instalada como app. Nada más que hacer acá.
            </p>
          ) : instalable ? (
            <Button className="mt-4 w-full sm:w-auto" onClick={handleInstalar}>
              Instalar Unify en este dispositivo
            </Button>
          ) : (
            <div className="mt-4 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
              {plataforma === "ios" ? (
                <>
                  <p className="font-medium text-strong">En iPhone o iPad (Safari):</p>
                  <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                    <li>
                      Tocá el botón <span className="font-semibold">Compartir</span> (el cuadrado con la flecha).
                    </li>
                    <li>
                      Elegí <span className="font-semibold">“Agregar a inicio”</span>.
                    </li>
                  </ol>
                </>
              ) : (
                <>
                  <p className="font-medium text-strong">En Chrome o Edge:</p>
                  <p className="mt-1.5">
                    Buscá el ícono de <span className="font-semibold">instalar</span> (un monitor con una flecha)
                    a la derecha de la barra de direcciones, o el menú ⋮ →{" "}
                    <span className="font-semibold">“Instalar Unify”</span>. Si no aparece, navegá la app un
                    momento y volvé: el navegador lo ofrece solo.
                  </p>
                </>
              )}
            </div>
          )}
          {/* Afuera del condicional a propósito: al aceptar la instalación el
              botón desaparece (el navegador ya no ofrece instalar) y este
              mensaje tiene que sobrevivirlo. */}
          {estado && !instalada && <p className="mt-3 text-sm text-emerald-300">{estado}</p>}
        </section>

        {/* ── 2. La extensión ───────────────────────────────────────── */}
        <section className={`${cardClass} mt-6`}>
          <h2 className="text-lg font-semibold text-strong">2 · La extensión para Chrome</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-300">
            Es la pieza que hace la magia automática: detecta que estás entrando a una reunión de Zoom, Meet,
            Teams, Jitsi o Webex y te ofrece subtítulos traducidos, transcripción y grabación sin salir de esa
            pestaña. Dentro de Google Meet, además, transcribe a <span className="font-semibold">todos</span>{" "}
            los participantes leyendo los subtítulos nativos.
          </p>

          {CHROME_WEB_STORE_URL ? (
            <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
              <Button className="mt-4 w-full sm:w-auto">Agregar a Chrome desde la Web Store</Button>
            </a>
          ) : (
            <div className="mt-4">
              <a href="/unify-extension.zip" download>
                <Button className="w-full sm:w-auto">Descargar la extensión (.zip)</Button>
              </a>
              <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
                <p className="font-medium text-strong">Instalarla lleva un minuto (hasta que esté en la Web Store):</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                  <li>Descomprimí el ZIP en una carpeta.</li>
                  <li>
                    En Chrome abrí <span className="font-mono text-[13px]">chrome://extensions</span> y prendé el{" "}
                    <span className="font-semibold">Modo de desarrollador</span> (arriba a la derecha).
                  </li>
                  <li>
                    Tocá <span className="font-semibold">“Cargar descomprimida”</span> y elegí esa carpeta.
                  </li>
                  <li>Entrá a cualquier reunión: Unify te la va a ofrecer solo.</li>
                </ol>
                <p className="mt-2 text-xs text-ink-400">
                  La extensión es de navegadores de escritorio (Chrome/Edge); en el teléfono, la app de arriba
                  cubre el modo companion.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* ── Qué pasa después ──────────────────────────────────────── */}
        <section className={`${cardClass} mt-6`}>
          <h2 className="text-lg font-semibold text-strong">Y después, todo solo</h2>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-300">
            <li>
              • Entrás a una reunión → aparece <span className="italic">“Veo que te estás uniendo…”</span>. Si no
              respondés, a los 5 segundos arrancan los subtítulos solos.
            </li>
            <li>• La grabación queda en tu historial, con la transcripción sincronizada palabra por palabra.</li>
            <li>• Le preguntás a la IA por lo que se dijo — y por lo que se VIO: también mira el video.</li>
            <li>• Subtítulos traducidos a chino, inglés, alemán, francés, portugués, italiano y español.</li>
          </ul>
          <p className="mt-3 text-xs text-ink-500">
            Qué guarda Unify y qué no:{" "}
            <Link to="/privacidad" className="underline hover:text-ink-300">
              política de privacidad
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
