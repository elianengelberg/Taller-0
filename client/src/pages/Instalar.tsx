import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { canPromptInstall, isStandalone, promptInstall } from "../pwa";
import { cardClass } from "../lib/ui";

// El centro de instalación: TODO Unify se instala desde esta página, y la
// página se adapta al dispositivo que la abre (Windows, Mac, iPhone/iPad,
// Android) para mostrar SOLO los pasos que le tocan a esa persona.
//
// El enlace para compartir es /instalar?bajar=1: al abrirse, la descarga del
// ZIP de la extensión arranca sola. Lo que un enlace NO puede hacer -- por
// diseño de Chrome, no por falta de ganas -- es instalar una extensión sin
// que la persona la cargue: esa experiencia de un clic la da la Chrome Web
// Store, y por eso el paso pendiente es publicar la ficha.

// Al publicar en la Chrome Web Store, pegá acá la URL de la ficha
// (https://chromewebstore.google.com/detail/…). Con esto puesto, el botón
// principal pasa a ser "Agregar a Chrome" y el ZIP queda como alternativa.
const CHROME_WEB_STORE_URL = "";

type Plataforma = "windows" | "mac" | "ios" | "android" | "otro";

function detectarPlataforma(): Plataforma {
  const ua = navigator.userAgent;
  // iPadOS se disfraza de Mac: lo delata el tacto.
  const esIpad = /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || esIpad) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "windows";
  return "otro";
}

const NOMBRE: Record<Plataforma, string> = {
  windows: "Windows",
  mac: "Mac",
  ios: "iPhone/iPad",
  android: "Android",
  otro: "tu equipo",
};

export default function Instalar() {
  const [instalable, setInstalable] = useState(canPromptInstall());
  const [instalada, setInstalada] = useState(isStandalone());
  const [estado, setEstado] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const plataforma = detectarPlataforma();
  const esApple = plataforma === "mac" || plataforma === "ios";
  const movil = plataforma === "ios" || plataforma === "android";

  useEffect(() => {
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

  // El enlace que se comparte: /instalar?bajar=1 arranca la descarga del ZIP
  // solo, apenas se abre la página (sólo tiene sentido en escritorio: en el
  // teléfono no hay extensiones de Chrome).
  const [searchParams] = useSearchParams();
  const bajarSolo = searchParams.get("bajar") === "1";
  const yaBajo = useRef(false);
  useEffect(() => {
    if (!bajarSolo || movil || yaBajo.current || CHROME_WEB_STORE_URL) return;
    yaBajo.current = true;
    const a = document.createElement("a");
    a.href = "/unify-extension.zip";
    a.download = "unify-extension.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [bajarSolo, movil]);

  async function handleInstalar() {
    setEstado(null);
    const ok = await promptInstall();
    setInstalable(canPromptInstall());
    if (ok) setEstado("¡Listo! Unify quedó instalada: buscala con las apps de tu dispositivo.");
    else setEstado("No hay problema — podés instalarla cuando quieras desde esta página.");
  }

  async function copiar(texto: string, etiqueta: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(etiqueta);
      setTimeout(() => setCopiado(null), 2500);
    } catch {
      setCopiado(null);
    }
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
          Detectamos que estás en <span className="font-semibold text-strong">{NOMBRE[plataforma]}</span>: esta
          página te muestra sólo los pasos que te tocan. Dos piezas: la{" "}
          <span className="font-semibold text-strong">app</span> (reuniones desde su propio ícono) y la{" "}
          <span className="font-semibold text-strong">extensión</span> que vigila por vos — entrás a un Zoom,
          Meet o Teams y te ofrece subtítulos y grabación; si no respondés, arranca sola a los 5 segundos.
        </p>
        {bajarSolo && !movil && (
          <p className="mt-3 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-200">
            La descarga de la extensión ya arrancó sola — mirá los pasos de abajo.
          </p>
        )}

        {/* ── 1. La app ─────────────────────────────────────────────── */}
        <section className={`${cardClass} mt-6`}>
          <h2 className="text-lg font-semibold text-strong">1 · La app de Unify</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-300">
            Sin tiendas ni descargas: se instala desde esta misma página y queda con su ícono
            {plataforma === "android" && ", y aparece en el menú Compartir de Android"}
            {esApple && plataforma === "ios" && ", en tu pantalla de inicio"}.
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
                      Tocá <span className="font-semibold">Compartir</span> (el cuadrado con la flecha hacia
                      arriba).
                    </li>
                    <li>
                      Elegí <span className="font-semibold">“Agregar a inicio”</span>.
                    </li>
                  </ol>
                </>
              ) : plataforma === "mac" ? (
                <>
                  <p className="font-medium text-strong">En Mac:</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5">
                    <li>
                      <span className="font-semibold">Chrome o Edge:</span> ícono de instalar (un monitor con una
                      flecha) a la derecha de la barra de direcciones, o menú ⋮ → “Instalar Unify”.
                    </li>
                    <li>
                      <span className="font-semibold">Safari:</span> menú Archivo →{" "}
                      <span className="font-semibold">“Agregar al Dock”</span>.
                    </li>
                  </ul>
                </>
              ) : (
                <>
                  <p className="font-medium text-strong">
                    {plataforma === "windows" ? "En Windows (Chrome o Edge):" : "En Chrome o Edge:"}
                  </p>
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

          {movil ? (
            <div className="mt-2 text-sm leading-relaxed text-ink-300">
              <p>
                Las extensiones de Chrome sólo existen en computadoras — {plataforma === "ios" ? "en iPhone/iPad" : "en el teléfono"},
                la app de arriba ya te cubre el modo companion.
              </p>
              <p className="mt-3">
                Para instalarla en tu computadora, mandate este enlace (la descarga arranca sola al abrirlo):
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-ink-800 px-3 py-2 text-xs text-brand-200">
                  {window.location.origin}/instalar?bajar=1
                </code>
                <button
                  type="button"
                  onClick={() => copiar(`${window.location.origin}/instalar?bajar=1`, "enlace")}
                  className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-100 hover:bg-ink-800"
                >
                  {copiado === "enlace" ? "¡Copiado!" : "Copiar enlace"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="mt-1 text-sm leading-relaxed text-ink-300">
                La pieza de la magia automática: detecta que entrás a una reunión de Zoom, Meet, Teams, Jitsi o
                Webex y te ofrece subtítulos traducidos, transcripción y grabación ahí mismo.
              </p>

              {CHROME_WEB_STORE_URL ? (
                <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
                  <Button className="mt-4 w-full sm:w-auto">Agregar a Chrome desde la Web Store</Button>
                </a>
              ) : (
                <div className="mt-4">
                  {!bajarSolo && (
                    <a href="/unify-extension.zip" download>
                      <Button className="w-full sm:w-auto">Descargar la extensión (.zip)</Button>
                    </a>
                  )}
                  <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
                    <p className="font-medium text-strong">
                      {plataforma === "mac" ? "En tu Mac, tres pasos:" : "En Windows, tres pasos:"}
                    </p>
                    <ol className="mt-1.5 list-decimal space-y-1.5 pl-5">
                      <li>
                        {plataforma === "mac" ? (
                          <>
                            Abrí la descarga: en Mac el ZIP{" "}
                            <span className="font-semibold">se descomprime solo con doble clic</span> (te queda la
                            carpeta “unify-extension” en Descargas — Safari hasta la descomprime por vos).
                          </>
                        ) : (
                          <>
                            En Descargas, clic derecho sobre <span className="font-mono text-[13px]">unify-extension.zip</span>{" "}
                            → <span className="font-semibold">“Extraer todo…”</span> → Extraer.
                          </>
                        )}
                      </li>
                      <li>
                        En Chrome, pegá esto en la barra de direcciones y prendé el{" "}
                        <span className="font-semibold">Modo de desarrollador</span> (arriba a la derecha):
                        <span className="mt-1.5 flex flex-wrap items-center gap-2">
                          <code className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs text-brand-200">
                            chrome://extensions
                          </code>
                          <button
                            type="button"
                            onClick={() => copiar("chrome://extensions", "chrome")}
                            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-100 hover:bg-ink-800"
                          >
                            {copiado === "chrome" ? "¡Copiado!" : "Copiar"}
                          </button>
                          <span className="text-xs text-ink-500">
                            (Chrome no deja que una página abra ese enlace por vos — hay que pegarlo)
                          </span>
                        </span>
                      </li>
                      <li>
                        Tocá <span className="font-semibold">“Cargar descomprimida”</span> y elegí la carpeta del
                        paso 1. Listo: entrá a cualquier reunión y Unify aparece solo.
                      </li>
                    </ol>
                    <p className="mt-2 text-xs text-ink-400">
                      Cuando la extensión esté publicada en la Chrome Web Store, esto va a ser un solo clic en
                      “Agregar a Chrome”.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── El enlace para compartir ──────────────────────────────── */}
        {!movil && (
          <section className={`${cardClass} mt-6`}>
            <h2 className="text-lg font-semibold text-strong">El enlace que instala</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-300">
              Compartí este enlace: a quien lo abra le arranca la descarga de la extensión sola y le muestra los
              pasos de SU sistema (Windows, Mac, iPhone o Android).
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="rounded-lg bg-ink-800 px-3 py-2 text-xs text-brand-200">
                {window.location.origin}/instalar?bajar=1
              </code>
              <button
                type="button"
                onClick={() => copiar(`${window.location.origin}/instalar?bajar=1`, "enlace")}
                className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-100 hover:bg-ink-800"
              >
                {copiado === "enlace" ? "¡Copiado!" : "Copiar enlace"}
              </button>
            </div>
          </section>
        )}

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
