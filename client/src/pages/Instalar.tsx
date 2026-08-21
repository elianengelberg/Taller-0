import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
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
  const [instalable, setInstalable] = useState(canPromptInstall());
  const [instalada, setInstalada] = useState(isStandalone());
  const [estado, setEstado] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const plataforma = detectarPlataforma();
  const esApple = plataforma === "mac" || plataforma === "ios";
  const movil = plataforma === "ios" || plataforma === "android";

  // ¿La extensión está en ESTE navegador? Es la pregunta que más confunde:
  // se instala en Edge, se abren las reuniones en Chrome, no aparece ningún
  // aviso y parece que Unify no funciona. Acá se responde sin adivinar.
  const [extVersion, setExtVersion] = useState<string | null>(extensionInstalada());
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
                <p className="mt-1 text-sm leading-relaxed text-ink-200">
                  Entrá a cualquier reunión y Unify te va a avisar solo. No hace falta que tengas la
                  app abierta.
                </p>
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
        <section className={`${cardClass} mt-6`}>
          <h2 className="text-lg font-semibold text-strong">1 · La app de Unify</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-300">
            Sin tiendas ni descargas: se instala desde esta misma página y queda con su ícono
            {plataforma === "android" && ", y aparece en el menú Compartir de Android"}
            {esApple && plataforma === "ios" && ", en tu pantalla de inicio"}.
          </p>

          {instalable ? (
            <Button className="mt-4 w-full sm:w-auto" onClick={handleInstalar}>
              Instalar Unify en este dispositivo
            </Button>
          ) : (
            <div className="mt-4 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
              {plataforma === "ios" ? (
                <>
                  <p className="font-medium text-strong">En iPhone o iPad, dos caminos:</p>
                  <p className="mt-2 font-medium text-ink-100">A · El rápido (dos toques, en Safari):</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    <li>
                      Tocá <span className="font-semibold">Compartir</span> (el cuadrado con la flecha hacia
                      arriba).
                    </li>
                    <li>
                      Elegí <span className="font-semibold">“Agregar a inicio”</span>.
                    </li>
                  </ol>
                  <p className="mt-3 font-medium text-ink-100">B · Con un archivo (perfil de Apple):</p>
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
        )}

        {/* ── 2. La extensión ───────────────────────────────────────── */}
        <section className={`${cardClass} mt-6`}>
          {/* Sin la sección de la app (ya instalada), numerar "2" sobraría. */}
          <h2 className="text-lg font-semibold text-strong">
            {instalada ? "La extensión para tu navegador" : "2 · La extensión para Chrome"}
          </h2>

          {movil ? (
            <div className="mt-2 text-sm leading-relaxed text-ink-300">
              <p>
                Las extensiones de Chrome sólo existen en computadoras — {plataforma === "ios" ? "en iPhone/iPad" : "en el teléfono"},
                la app de arriba ya te cubre el modo companion.
              </p>
              {plataforma === "ios" && (
                <p className="mt-2 text-xs text-ink-400">
                  Y para que no pierdas tiempo: un ZIP no instala nada en un iPad — iPadOS no ejecuta
                  archivos, es una regla de Apple. El único “archivo que instala” en iPad es el perfil de
                  arriba, y es para la app.
                </p>
              )}
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
                La pieza de la magia automática: detecta que entrás a una reunión de Zoom, Meet, Teams, Jitsi,
                Webex, Whereby o GoTo y te ofrece subtítulos traducidos, transcripción y grabación ahí mismo.
              </p>

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
                  <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
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
                  <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/60 p-4 text-sm leading-relaxed text-ink-200">
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
              Compartí este enlace: a quien lo abra le arranca sola la descarga del{" "}
              <span className="font-semibold text-strong">ZIP de la extensión</span> y le muestra los pasos de SU
              sistema y navegador (Windows, Mac, iPhone o Android; Chrome o Edge).
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
