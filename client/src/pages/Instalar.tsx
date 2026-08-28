import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { AppMockupDesktop, AppMockupPhone } from "../components/AppMockup";
import { AppleIcon, WindowsIcon, AndroidIcon } from "../components/icons";
import {
  canPromptInstall,
  extensionInstalada,
  isStandalone,
  onExtensionDetectada,
  promptInstall,
} from "../pwa";
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
// PUBLICADA el 22/8/2026. La forma con sólo el ID es la canónica y estable:
// la tienda redirige sola a la URL con el nombre, y si algún día cambia el
// título del elemento, este enlace sigue funcionando.
const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/elnehilolmbolklgagfegbkibmdjgpbb";

// El instalador de la app de escritorio para Windows (ver desktop/README.md):
// "latest" de GitHub Releases, así publicar una versión nueva no toca la web.
const DESCARGA_WINDOWS =
  "https://github.com/elianengelberg/Taller-0/releases/latest/download/Unify-Setup.exe";

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

// ¿Safari de verdad, o Chrome/Edge/Firefox de iPhone? Desde iOS 16.4 los
// otros navegadores TAMBIÉN pueden agregar la app a la pantalla de inicio
// (antes era exclusivo de Safari), pero el gesto es distinto (va por su menú
// Compartir) y en un iOS viejo directamente no existe: a cada uno se le
// muestran SUS pasos, con Safari como plan B.
function esSafariDeIos(): boolean {
  return !/CriOS|FxiOS|EdgiOS|OPiOS|Brave/i.test(navigator.userAgent);
}

function esIpadPuntual(): boolean {
  const ua = navigator.userAgent;
  return /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
}

// Edge se anuncia como "Edg/": su página de extensiones es edge://extensions
// y ahí el Modo de desarrollador vive a la IZQUIERDA, no arriba a la derecha.
// Detectarlo evita mandar a alguien de Edge a pegar una URL de Chrome.
function esEdge(): boolean {
  return /Edg\//.test(navigator.userAgent);
}

const NOMBRE: Record<Plataforma, string> = {
  windows: "Windows",
  mac: "Mac",
  ios: "iPhone/iPad",
  android: "Android",
  otro: "tu equipo",
};

export default function Instalar() {
  useDocumentTitle("Instalar");
  const [instalable, setInstalable] = useState(canPromptInstall());
  const [instalada, setInstalada] = useState(isStandalone());
  const [estado, setEstado] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  // Se detecta el sistema al entrar, pero se puede CAMBIAR con los chips de
  // abajo: alguien en Windows que prepara el iPhone de un compañero, o el de
  // sistemas que arma las 100 máquinas de la empresa, ve los pasos de
  // cualquiera sin cambiar de aparato.
  const [plataforma, setPlataforma] = useState<Plataforma>(detectarPlataforma());
  const [autodetectada] = useState<Plataforma>(detectarPlataforma());
  const esApple = plataforma === "mac" || plataforma === "ios";
  const movil = plataforma === "ios" || plataforma === "android";

  // ¿La extensión está en ESTE navegador? Es la pregunta que más confunde:
  // se instala en Edge, se abren las reuniones en Chrome, no aparece ningún
  // aviso y parece que Unify no funciona. Acá se responde sin adivinar.
  const [extVersion, setExtVersion] = useState<string | null>(extensionInstalada());
  // Se acaba de instalar la app y sigue la extensión: para resaltar ese paso
  // y llevar la vista hasta él, en vez de dejar a la persona buscándolo.
  const [siguientePaso, setSiguientePaso] = useState(false);
  const seccionExt = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const soltar = onExtensionDetectada(setExtVersion);
    // El content script se anuncia al cargar la página; si esta pantalla se
    // montó antes, la marca ya podría estar puesta.
    const t = setTimeout(() => setExtVersion(extensionInstalada()), 1200);
    return () => {
      soltar();
      clearTimeout(t);
    };
  }, []);
  // ¿La versión instalada quedó vieja? La web siempre sirve la última al
  // lado del ZIP (version-extension.json); compararla acá avisa de frente,
  // sin esperar al chequeo periódico del fondo de la extensión.
  const [ultimaVersion, setUltimaVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch("/version-extension.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => setUltimaVersion(d?.version ?? null))
      .catch(() => {});
  }, []);
  const extVieja = Boolean(extVersion && ultimaVersion && extVersion !== ultimaVersion);

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
  // solo, apenas se abre la página. En CUALQUIER dispositivo: si lo abrís en
  // el teléfono, el ZIP baja igual y lo pasás a la compu como cualquier
  // archivo.
  const [searchParams] = useSearchParams();
  const bajarSolo = searchParams.get("bajar") === "1";
  const yaBajo = useRef(false);
  useEffect(() => {
    // Con la tienda publicada, en ESCRITORIO ?bajar=1 no baja el ZIP (la
    // sección ofrece "Agregar a Chrome", que es mejor). En el TELÉFONO la
    // tienda no instala nada, así que ahí el ZIP baja directo igual.
    if (!bajarSolo || yaBajo.current || (CHROME_WEB_STORE_URL && !movil)) return;
    yaBajo.current = true;
    // Siempre el ZIP: un .zip baja sin escándalo en cualquier navegador. El
    // .bat que probamos antes disparaba la alarma de Edge y SmartScreen en
    // cadena (a un .bat descargado lo tratan como malware hasta que se
    // demuestre lo contrario) y encima abría una terminal. Nunca más como
    // camino principal.
    const archivo = "unify-extension.zip";
    const a = document.createElement("a");
    a.href = `/${archivo}`;
    a.download = archivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [bajarSolo, movil, plataforma]);

  // Instalar la app ENCADENA el paso de la extensión.
  //
  // "Que al instalar la app se instale también la extensión" no se puede
  // hacer literalmente: desde 2018 ninguna página puede instalar una
  // extensión por vos -- Chrome lo prohíbe para que ningún sitio te meta
  // código en el navegador sin tu permiso. Lo más cerca que se puede llegar,
  // y lo que hace esto, es que los dos pasos ocurran seguidos sin que tengas
  // que buscar nada: aceptás la app y aparece la extensión lista para sumar,
  // con la descarga ya empezada (o la tienda abierta, cuando esté publicada).
  async function handleInstalar() {
    setEstado(null);
    const ok = await promptInstall();
    setInstalable(canPromptInstall());
    if (!ok) {
      setEstado("No hay problema — podés instalarla cuando quieras desde esta página.");
      return;
    }
    setEstado("¡Listo! Unify quedó instalada. Ahora, el segundo paso: la extensión.");
    if (movil || extVersion) return; // en el teléfono no hay extensiones; si ya está, nada que hacer
    setSiguientePaso(true);
    if (CHROME_WEB_STORE_URL) {
      // Mismo gesto de la persona: el navegador suele permitir la pestaña.
      window.open(CHROME_WEB_STORE_URL, "_blank", "noopener");
    } else {
      bajarExtension();
    }
    // La extensión queda a la vista, no hay que ir a buscarla más abajo.
    setTimeout(() => seccionExt.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
  }

  /** Arranca la descarga del ZIP (el mismo archivo que sirve /instalar?bajar=1). */
  function bajarExtension() {
    const a = document.createElement("a");
    a.href = "/unify-extension.zip";
    a.download = "unify-extension.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
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
      <div className="relative mx-auto max-w-5xl">
        <div className="mb-10 flex items-center justify-between gap-3">
          <Link to="/" aria-label="Ir al inicio">
            <Logo />
          </Link>
          <Link to="/" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong">
            Volver al inicio
          </Link>
        </div>

        {/* El héroe estilo Discord: título ENORME a un lado, el mockup del
            producto al otro sobre un blob de color. Los botones grandes con
            ícono de plataforma reemplazan a los chips (el detectado queda
            marcado y arranca su sección). */}
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h1 className="font-display text-5xl font-extrabold uppercase leading-[0.95] tracking-tight text-strong sm:text-6xl">
              Instalá<br />Unify
            </h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-300">
              La app para abrir tus reuniones, y la extensión que te avisa apenas entrás a un Zoom o
              Meet. Un par de toques y listo.
            </p>

            {!instalada && instalable && (
              <Button className="mt-7 px-8 py-3.5 text-base shadow-soft" onClick={handleInstalar}>
                Instalar Unify en este dispositivo
              </Button>
            )}

            <div className="mt-7">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                Elegí tu sistema
              </p>
              <div
                className="mt-3 flex flex-wrap gap-3"
                role="group"
                aria-label="Elegí el sistema"
              >
                {(
                  [
                    ["windows", WindowsIcon],
                    ["mac", AppleIcon],
                    ["ios", AppleIcon],
                    ["android", AndroidIcon],
                  ] as [Plataforma, typeof AppleIcon][]
                ).map(([sys, Icono]) => (
                  <button
                    key={sys}
                    type="button"
                    onClick={() => {
                      setPlataforma(sys);
                      document.getElementById("app")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    aria-pressed={plataforma === sys}
                    className={`flex min-h-[52px] items-center gap-2.5 rounded-2xl px-5 py-3 text-sm font-semibold shadow-soft transition ${
                      plataforma === sys
                        ? "bg-brand-500 text-on-accent"
                        : "bg-ink-800 text-strong ring-1 ring-ink-700 hover:ring-brand-400"
                    }`}
                  >
                    <Icono className="h-5 w-5" />
                    <span>
                      {NOMBRE[sys]}
                      {autodetectada === sys && (
                        <span className="text-xs font-normal opacity-80">{" · el tuyo"}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <AppMockupDesktop className="hidden lg:block" />
        </div>

        {/* En pantallas chicas, un mockup de teléfono bajo el héroe. */}
        <div className="mt-12 flex justify-center lg:hidden">
          <AppMockupPhone />
        </div>
        {bajarSolo && !movil && (
          <p className="mt-3 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-2.5 text-sm text-brand-200">
            La descarga de la extensión ya arrancó sola — mirá los pasos de abajo.
          </p>
        )}

        {/* ── El estado de la extensión, arriba de todo ──────────────
            Es lo primero que hay que saber: sin extensión en ESTE navegador
            no hay avisos al entrar a una reunión, por más que la app esté
            abierta (ninguna web puede ver las otras pestañas). */}
        {!movil && (
          <section
            className={`mt-6 rounded-2xl border px-5 py-4 ${
              extVersion
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            {extVersion ? (
              <>
                <p className="text-sm font-semibold text-emerald-300">
                  ✓ La extensión está instalada en este navegador (versión {extVersion})
                </p>
                {extVieja ? (
                  <p className="mt-1 text-sm leading-relaxed text-amber-300">
                    Hay una versión nueva ({ultimaVersion}). Si la instalaste desde la Chrome Web
                    Store se actualiza sola; si la cargaste por ZIP, bajá el ZIP de abajo de nuevo y
                    recargala en <span className="font-mono">chrome://extensions</span>.
                  </p>
                ) : (
                  <p className="mt-1 text-sm leading-relaxed text-ink-200">
                    Entrá a cualquier reunión y Unify te va a avisar solo. No hace falta que tengas
                    la app abierta.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-amber-300">
                  ⚠ La extensión NO está instalada en este navegador
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-200">
                  Por eso no aparece ningún aviso al entrar a una reunión. Ojo: se instala{" "}
                  <span className="font-semibold text-strong">en cada navegador por separado</span> — si
                  la pusiste en Edge y abrís las reuniones en Chrome, hay que instalarla también acá.
                  Los pasos están abajo.
                </p>
              </>
            )}
          </section>
        )}

        {/* ── 1. La app ─────────────────────────────────────────────── */}
        {!instalada && (
        <section id="app" className={`${cardClass} mt-6 scroll-mt-6`}>
          <h2 className="text-lg font-semibold text-strong">La app</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-300">
            Sin tiendas ni descargas: queda con su ícono
            {plataforma === "android" && ", y aparece en el menú Compartir de Android"}
            {esApple && plataforma === "ios" && ", en tu pantalla de inicio"}.
          </p>

          {instalable ? (
            <p className="mt-3 text-sm text-ink-400">
              Tocá el botón grande de arriba y ya queda instalada.
            </p>
          ) : (
            <div className="mt-4 text-sm leading-relaxed text-ink-200">
              {plataforma === "ios" ? (
                <>
                  {!esSafariDeIos() && (
                    <div className="mb-4 border-l-2 border-brand-400 pl-3">
                      <p className="text-sm font-semibold text-brand-200">
                        Estás en Chrome o Edge de iPhone: también se puede
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-200">
                        Desde iOS 16.4, estos navegadores también instalan la app: tocá{" "}
                        <span className="font-semibold">Compartir</span> (el cuadrado con la flecha, en la
                        barra o dentro del menú ⋯&#8202;/&#8202;≡) y elegí{" "}
                        <span className="font-semibold">“Agregar a pantalla de inicio”</span>.
                      </p>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
                        ¿No te aparece esa opción? Tu iPhone tiene un iOS más viejo: copiá el enlace y
                        hacelo desde Safari, que puede siempre.
                      </p>
                      <button
                        type="button"
                        onClick={() => copiar(`${window.location.origin}/instalar`, "safari")}
                        className="mt-1 inline-block min-h-[40px] text-xs font-medium text-ink-300 underline underline-offset-2 hover:text-ink-100"
                      >
                        {copiado === "safari" ? "Copiado ✓ — ahora pegalo en Safari" : "Copiar el enlace para Safari"}
                      </button>
                    </div>
                  )}
                  <p className="font-medium text-strong">
                    En {esIpadPuntual() ? "iPad" : "iPhone"}, sin tiendas ni descargas (dos toques, en Safari):
                  </p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    <li>
                      Tocá <span className="font-semibold">Compartir</span> (el cuadrado con la flecha hacia
                      arriba).
                    </li>
                    <li>
                      Elegí <span className="font-semibold">“Agregar a inicio”</span> (o “Agregar a pantalla de
                      inicio”). Listo: Unify queda con su ícono, como una app más.
                    </li>
                  </ol>
                  {esIpadPuntual() && (
                    <>
                      {/* El perfil es un camino para iPadS ADMINISTRADOS (una
                          empresa que precarga el acceso): en un iPhone común
                          sólo confundía -- "toco descargar y no pasa nada". */}
                      <p className="mt-3 font-medium text-ink-100">Alternativa para iPads de empresa (perfil de Apple):</p>
                      <a href="/unify-ipad.mobileconfig" className="mt-1.5 inline-block">
                        <Button variant="secondary">Descargar el perfil para iPad</Button>
                      </a>
                      <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                        <li>Tocá el botón (en Safari) y aceptá <span className="font-semibold">“Permitir”</span>.</li>
                        <li>
                          Abrí <span className="font-semibold">Ajustes</span> → arriba aparece{" "}
                          <span className="font-semibold">“Perfil descargado”</span> → <span className="font-semibold">Instalar</span>.
                        </li>
                        <li>Unify queda en tu pantalla de inicio, con su ícono, a pantalla completa.</li>
                      </ol>
                      <p className="mt-2 text-xs text-ink-400">
                        Es un perfil de configuración estándar de Apple, sólo con el acceso directo de Unify
                        adentro; se borra cuando quieras desde Ajustes.
                      </p>
                    </>
                  )}
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
              ) : plataforma === "android" ? (
                <>
                  <p className="font-medium text-strong">En Android, desde Chrome o desde Edge:</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5">
                    <li>
                      <span className="font-semibold">Chrome:</span> menú ⋮ →{" "}
                      <span className="font-semibold">“Instalar app”</span> (o “Agregar a pantalla
                      principal”).
                    </li>
                    <li>
                      <span className="font-semibold">Edge:</span> menú ≡ →{" "}
                      <span className="font-semibold">“Agregar al teléfono”</span> (o “Instalar app”).
                    </li>
                  </ul>
                  <p className="mt-2 text-xs text-ink-400">
                    Hacen exactamente lo mismo que el botón de arriba cuando aparece: Unify queda con su
                    ícono, como una app más, y se actualiza sola.
                  </p>
                </>
              ) : (
                <>
                  {plataforma === "windows" && (
                    <div className="mb-5 rounded-2xl border border-brand-500/40 bg-brand-500/10 p-4">
                      <p className="text-sm font-semibold text-brand-200">
                        Unify para Windows: el programa completo
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-ink-200">
                        Se instala como cualquier programa y queda al lado del reloj. Cuando te unís
                        a una reunión <span className="font-semibold text-strong">desde la app de Zoom</span>,
                        te pregunta si la querés grabar — con subtítulos, traducción e IA — y al
                        terminar te abre todo en tu historial.
                      </p>
                      <a href={DESCARGA_WINDOWS} className="mt-3 inline-block">
                        <Button>Descargar Unify para Windows</Button>
                      </a>
                      <p className="mt-2 text-xs text-ink-400">
                        Un instalador común (.exe): siguiente, siguiente, listo.
                      </p>
                    </div>
                  )}
                  <p className="font-medium text-strong">
                    {plataforma === "windows"
                      ? "¿Preferís la versión liviana? En Windows (Chrome o Edge):"
                      : "En Chrome o Edge:"}
                  </p>
                  <p className="mt-1.5">
                    Mirá arriba a la derecha, al final de la barra donde va la dirección de la
                    página: hay un iconito de <span className="font-semibold">instalar</span> (una
                    pantallita con una flecha). Tocalo y aceptá. Si no lo ves, tocá el menú de los
                    tres puntitos (⋮) y elegí <span className="font-semibold">“Instalar Unify”</span>.
                    Con eso Unify queda en tu compu con su propio ícono.
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
        )}

        {/* ── 2. La extensión ───────────────────────────────────────── */}
        <section
          id="ext"
          ref={seccionExt}
          className={`${cardClass} mt-6 scroll-mt-6 ${
            siguientePaso ? "border-brand-500/60 ring-1 ring-brand-500/40" : ""
          }`}
        >
          {siguientePaso && (
            <p className="mb-3 text-sm font-semibold text-brand-200">
              Paso 2 de 2 — la descarga ya arrancó, seguí acá abajo
            </p>
          )}
          {/* Sin la sección de la app (ya instalada), numerar "2" sobraría. */}
          <h2 className="text-lg font-semibold text-strong">
            {instalada ? "La extensión para tu navegador" : "La extensión"}
          </h2>

          {movil ? (
            <div className="mt-2 text-sm leading-relaxed text-ink-300">
              <p>
                Tocá el botón y se descarga directo. Después la instalás en el Chrome o Edge de tu
                computadora (ahí es donde vive una extensión).
              </p>
              <div className="mt-3">
                <Button onClick={bajarExtension}>Descargar la extensión</Button>
              </div>
              <p className="mt-3 text-xs text-ink-400">
                Se baja un archivo ZIP. En la computadora: descomprimilo, abrí{" "}
                <code className="rounded bg-ink-800 px-1">chrome://extensions</code>, prendé «Modo de
                desarrollador» y tocá «Cargar descomprimida» eligiendo la carpeta. Los pasos con
                detalle están en esta misma página abierta desde la compu.
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 text-sm leading-relaxed text-ink-300">
                Se instala una vez y funciona sola: entrás a una reunión y el cartel aparece.{" "}
                <span className="font-semibold text-strong">No hace falta abrir Unify</span> ni tener la app a
                la vista.
              </p>
              <div className="mt-3 text-sm leading-relaxed text-ink-200">
                <p className="text-xs text-ink-400">
                  ¿La querés 24/7? Poné el navegador para que arranque con Windows
                  (Configuración → Aplicaciones → Inicio) y listo, sin que
                  abras nada.
                </p>
              </div>

              {CHROME_WEB_STORE_URL ? (
                <>
                  <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
                    <Button className="mt-4 w-full sm:w-auto">
                      {esEdge() ? "Agregar a Edge desde la Chrome Web Store" : "Agregar a Chrome desde la Web Store"}
                    </Button>
                  </a>
                  {esEdge() && (
                    <p className="mt-2 text-xs text-ink-400">
                      Edge instala extensiones de la Chrome Web Store: si te lo pregunta, tocá{" "}
                      <span className="font-semibold">“Permitir extensiones de otras tiendas”</span> y después{" "}
                      “Agregar a Chrome”.
                    </p>
                  )}
                  <p className="mt-3 text-sm leading-relaxed text-ink-300">
                    Un clic y listo. Desde la tienda también se actualiza sola cuando sacamos mejoras.
                  </p>
                  {/* El ZIP no se retira: hay equipos de trabajo con la tienda
                      bloqueada por política, y ahí sigue siendo el único
                      camino. Queda chico y abajo, como alternativa. */}
                  <p className="mt-3 text-xs text-ink-400">
                    ¿La tienda está bloqueada en tu computadora del trabajo?{" "}
                    <a href="/unify-extension.zip" download className="underline hover:text-ink-200">
                      Bajá el ZIP
                    </a>{" "}
                    y cargalo a mano desde{" "}
                    <button
                      type="button"
                      onClick={() => copiar(esEdge() ? "edge://extensions" : "chrome://extensions", "exts")}
                      className="underline hover:text-ink-200"
                    >
                      {esEdge() ? "edge://extensions" : "chrome://extensions"}{copiado === "exts" ? " ✓" : ""}
                    </button>{" "}
                    (Modo de desarrollador → “Cargar descomprimida”). Ojo: el ZIP es la única
                    forma que no se actualiza sola; cuando puedas, instalala de la tienda y te
                    olvidás para siempre.
                  </p>
                </>
              ) : plataforma === "mac" ? (
                <div className="mt-4">
                  {/* En Mac, el patrón de siempre: un comando para Terminal.
                      (Un .command descargado pierde el permiso de ejecución y
                      Gatekeeper lo frena: pegar el comando es MENOS pasos.) */}
                  <p className="text-sm font-medium text-strong">
                    Copiá esto y pegalo en Terminal (⌘ Espacio → “Terminal” → Enter):
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-ink-900 px-3 py-2 text-xs text-brand-200">
                      curl -fsSL https://www.unify-meet.com/instalar-unify.command | bash
                    </code>
                    <button
                      type="button"
                      onClick={() => copiar("curl -fsSL https://www.unify-meet.com/instalar-unify.command | bash", "terminal")}
                      className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-semibold text-ink-100 hover:bg-ink-800"
                    >
                      {copiado === "terminal" ? "¡Copiado!" : "Copiar"}
                    </button>
                  </div>
                  <div className="mt-4 text-sm leading-relaxed text-ink-200">
                    <p>
                      El instalador descarga la extensión, la deja en su carpeta, te{" "}
                      <span className="font-semibold">copia la ruta al portapapeles</span> y te abre la página de
                      extensiones de Chrome. Ahí quedan los dos toques que Chrome exige sí o sí:
                    </p>
                    <ol className="mt-1.5 list-decimal space-y-1 pl-5">
                      <li>Prendé el <span className="font-semibold">Modo de desarrollador</span> (arriba a la derecha).</li>
                      <li>Tocá <span className="font-semibold">“Cargar descomprimida”</span> y pegá la ruta (⌘V).</li>
                    </ol>
                    <p className="mt-2 text-xs text-ink-400">
                      Es un script de texto plano:{" "}
                      <a href="/instalar-unify.command" className="underline hover:text-ink-200">leelo acá</a> antes
                      de correrlo si querés. Alternativa manual:{" "}
                      <a href="/unify-extension.zip" download className="underline hover:text-ink-200">bajar el ZIP</a>{" "}
                      (doble clic lo descomprime) y cargar esa carpeta a mano.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  {/* Camino principal: el ZIP. Sin terminal y sin sustos -- el
                      .bat que probamos antes hacía saltar los avisos de
                      seguridad de Edge y SmartScreen en cadena (a un .bat
                      descargado lo tratan como malware) y abría una consola
                      negra en la cara de la persona. Quedó como alternativa,
                      abajo y con la advertencia dicha de antemano. */}
                  <a href="/unify-extension.zip" download>
                    <Button className="w-full sm:w-auto">Descargar la extensión (ZIP)</Button>
                  </a>
                  <div className="mt-4 text-sm leading-relaxed text-ink-200">
                    <p className="font-medium text-strong">
                      Cuatro pasos, sin terminal ni avisos de seguridad{esEdge() ? " (estás en Edge: los pasos son los de Edge)" : ""}:
                    </p>
                    <ol className="mt-1.5 list-decimal space-y-1.5 pl-5">
                      <li>
                        En <span className="font-semibold">Descargas</span>, clic derecho sobre{" "}
                        <span className="font-mono text-[13px]">unify-extension.zip</span> →{" "}
                        <span className="font-semibold">“Extraer todo…”</span> → Extraer.
                      </li>
                      <li>
                        Pegá{" "}
                        <button
                          type="button"
                          onClick={() => copiar(esEdge() ? "edge://extensions" : "chrome://extensions", "exts")}
                          className="rounded-md bg-ink-900 px-2 py-0.5 font-mono text-[13px] text-brand-200 hover:bg-ink-700"
                          title="Tocá para copiar"
                        >
                          {esEdge() ? "edge://extensions" : "chrome://extensions"}{copiado === "exts" ? " ✓" : ""}
                        </button>{" "}
                        en la barra de direcciones (tocá para copiarlo) y apretá Enter.
                      </li>
                      <li>
                        Prendé el <span className="font-semibold">Modo de desarrollador</span>{" "}
                        {esEdge() ? "(en Edge está en el panel de la izquierda)" : "(arriba a la derecha)"}.
                      </li>
                      <li>
                        Tocá <span className="font-semibold">“Cargar descomprimida”</span> y elegí la carpeta{" "}
                        <span className="font-mono text-[13px]">unify-extension</span> que quedó en Descargas.
                        Listo: entrá a cualquier reunión y Unify aparece solo.
                      </li>
                    </ol>
                    <p className="mt-2 text-xs text-ink-400">
                      Los dos toques finales los exige el navegador sí o sí: ninguna página puede activar una
                      extensión por vos. Cuando Unify esté en la Chrome Web Store, todo esto será un solo clic
                      {esEdge() ? " (también desde Edge)" : ""}.
                    </p>
                    <p className="mt-2 text-xs text-ink-400">
                      ¿Preferís que un script haga la descarga y descompresión por vos?{" "}
                      <a href="/instalar-unify.bat" download className="underline hover:text-ink-200">
                        instalar-unify.bat
                      </a>{" "}
                      existe, pero avisamos de antemano: por ser un .bat, Windows y Edge le muestran varios avisos
                      de seguridad y abre una ventana de terminal — es texto plano y podés leerlo con el Bloc de
                      notas, pero el camino de arriba es más tranquilo.
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
              Compartilo y a quien lo abra le baja la extensión sola, con los pasos de su sistema.
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
            ¿Algo no anduvo?{" "}
            <Link to="/soporte" className="underline hover:text-ink-300">
              Centro de ayuda
            </Link>
            . Qué guarda Unify y qué no:{" "}
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
