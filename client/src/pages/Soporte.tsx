import { Link } from "react-router-dom";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { cardClass } from "../lib/ui";

// Centro de ayuda de Unify. Es la "URL de asistencia" que pide la ficha de la
// Chrome Web Store: las respuestas a lo que la gente pregunta de verdad,
// escritas con las mismas reglas del producto (decir la verdad, incluso
// cuando la respuesta es "eso Chrome no lo deja hacer").
export default function Soporte() {
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

        <h1 className="text-3xl font-bold text-strong">Ayuda de Unify</h1>
        <p className="mt-2 text-sm text-ink-400">
          Las respuestas rápidas a lo que más se pregunta. Si lo tuyo no está acá, abajo tenés el contacto.
        </p>

        <div className={`${cardClass} mt-6 space-y-6 text-sm leading-relaxed text-ink-200`}>
          <section>
            <h2 className="text-base font-semibold text-strong">¿Cómo instalo Unify?</h2>
            <p className="mt-1.5">
              Todo se instala desde{" "}
              <Link to="/instalar" className="text-brand-300 underline">
                unify-meet.com/instalar
              </Link>
              : la página detecta tu equipo (Windows, Mac, iPhone/iPad o Android; Chrome o Edge) y te muestra
              sólo los pasos que te tocan — la app con un clic y la extensión con su ZIP.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Entré a una reunión y no apareció el aviso</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                Fijate que la extensión esté activa: escribí <code className="text-brand-200">chrome://extensions</code>{" "}
                (en Edge, <code className="text-brand-200">edge://extensions</code>) en la barra y verificá que
                Unify esté encendida.
              </li>
              <li>Recargá la pestaña de la reunión: la extensión se engancha al cargar la página.</li>
              <li>
                Funciona en Google Meet, Zoom (web), Teams, Jitsi, Webex, Whereby y GoTo. En la app de
                escritorio de Zoom (el programa instalado, no la pestaña) una extensión de navegador no puede
                entrar: uní por el navegador y listo.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Me pide “una acción desde la barra” para grabar</h2>
            <p className="mt-1.5">
              Es una regla de Chrome, no un capricho: capturar la pestaña exige que VOS invoques la extensión.
              Apretá <span className="font-semibold">Ctrl+Shift+U</span> (⌘⇧U en Mac) o tocá el ícono de Unify y
              después “Grabar”. El botón del aviso dentro de la página también sirve: abre el selector de
              pantalla con la pestaña ya elegida.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">¿Dónde quedan mis grabaciones y transcripciones?</h2>
            <p className="mt-1.5">
              En tu historial de{" "}
              <a href="https://www.unify-meet.com" className="text-brand-300 underline">
                unify-meet.com
              </a>{" "}
              (con tu cuenta): el video, la transcripción sincronizada palabra por palabra y la IA para
              preguntar sobre lo que se dijo — y lo que se vio.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">La IA no me responde</h2>
            <p className="mt-1.5">
              La IA necesita sesión iniciada (cada pregunta cuesta dinero y no puede quedar abierta a
              anónimos). Los subtítulos, la traducción y la grabación funcionan igual sin cuenta.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">¿Y la traducción?</h2>
            <p className="mt-1.5">
              Arranca sola en el idioma de tu navegador y la cambiás en el selector del panel (chino, inglés,
              alemán, francés, portugués, italiano y español). “Sin traducir” también es una opción y se
              respeta.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">¿Cómo se actualiza?</h2>
            <p className="mt-1.5">
              La app avisa sola cuando hay versión nueva (y nunca en medio de una reunión). La extensión
              instalada desde la tienda se actualiza sola; si la cargaste por ZIP, el ícono muestra una
              flechita ↑ y el popup te lleva a bajar la nueva desde{" "}
              <Link to="/instalar" className="text-brand-300 underline">
                /instalar
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Contacto</h2>
            <p className="mt-1.5">
              ¿Otra cosa? Escribinos a{" "}
              <a href="mailto:hola@unify-meet.com" className="text-brand-300 underline">
                hola@unify-meet.com
              </a>{" "}
              contando qué pasó y en qué plataforma (Meet, Zoom, etc.). Qué guardamos y qué no:{" "}
              <Link to="/privacidad" className="text-brand-300 underline">
                política de privacidad
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
