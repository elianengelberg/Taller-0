import { Link } from "react-router-dom";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { cardClass } from "../lib/ui";

// Política de privacidad de Unify (web + extensión). La Chrome Web Store
// exige una URL pública de privacidad para publicar la extensión: es ésta.
// Escrita para que la entienda una persona, no para cubrir expedientes --
// y fiel a lo que el código hace de verdad.
export default function Privacidad() {
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

        <h1 className="text-3xl font-bold text-strong">Privacidad en Unify</h1>
        <p className="mt-2 text-sm text-ink-400">Vale para la web/app (unify-meet.com) y la extensión de Chrome.</p>

        <div className={`${cardClass} mt-6 space-y-5 text-sm leading-relaxed text-ink-200`}>
          <section>
            <h2 className="text-base font-semibold text-strong">Qué guardamos y para qué</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-strong">Tu cuenta:</span> email, nombre, foto de perfil (si
                elegís una) y la contraseña — sólo como hash irreversible (scrypt): nadie puede leerla, ni
                nosotros.
              </li>
              <li>
                <span className="font-medium text-strong">Tus reuniones:</span> chat, transcripción, grabación e
                informes de IA. Se guardan para que VOS los veas en tu historial, que es privado por cuenta:
                nadie más lo ve, salvo las carpetas que vos decidas compartir.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Qué hace la extensión (y qué no)</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                Corre únicamente en páginas de reuniones (Google Meet, Zoom, Teams, Jitsi, Webex) y en la web de
                Unify. No lee tu navegación en ningún otro sitio.
              </li>
              <li>
                <span className="font-medium text-strong">No graba ni transcribe nada sin decírtelo:</span>{" "}
                siempre hay un aviso visible, y la captura de pantalla o pestaña sólo arranca con una acción tuya
                (así funciona Chrome, y así lo queremos).
              </li>
              <li>
                Lo que capta (subtítulos, audio de la reunión que grabás) viaja cifrado (HTTPS) al servidor de
                Unify y a ningún otro lado. No hay analytics, trackers ni venta de datos — ni en la web ni en la
                extensión.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Terceros que tocan tus datos</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-strong">Anthropic (Claude):</span> procesa la transcripción (y
                los fotogramas del video, si le preguntás por lo que se vio) para responder tus preguntas,
                traducir y armar informes. No usa tus datos para entrenar modelos.
              </li>
              <li>
                <span className="font-medium text-strong">Infraestructura:</span> la base de datos y el servidor
                corren en Render, los videos y fotos en Cloudflare R2, la web en Vercel, y los correos de
                verificación/recuperación salen por Resend.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Tu control</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>Podés borrar cualquier reunión de tu historial: se borra con su transcripción, chat, informe y grabación.</li>
              <li>Podés cerrar la sesión en todos los dispositivos desde la configuración de tu cuenta.</li>
              <li>
                Antes de grabar a otras personas, avisales — en varios países es obligación legal de quien graba.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">Contacto</h2>
            <p className="mt-1.5">
              Cualquier duda o pedido sobre tus datos: escribinos a{" "}
              <a href="mailto:hola@unify-meet.com" className="text-brand-300 underline">
                hola@unify-meet.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
