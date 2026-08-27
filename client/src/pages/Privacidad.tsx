import { Link } from "react-router-dom";
import GradientBackdrop from "../components/GradientBackdrop";
import Logo from "../components/Logo";
import { cardClass } from "../lib/ui";

// Política de privacidad y seguridad de Unify (web + extensión). La Chrome
// Web Store exige una URL pública de privacidad: es ésta. Escrita para que
// la entienda una persona -- y fiel a lo que el código hace de verdad: cada
// afirmación de acá tiene su contraparte en el servidor (scrypt, tokens
// hasheados de un solo uso, revocación de sesiones, límites de intentos).
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

        <h1 className="text-3xl font-bold text-strong">Política de privacidad y seguridad</h1>
        <p className="mt-2 text-sm text-ink-400">
          Vale para la web/app (unify-meet.com) y la extensión de Chrome/Edge. Última actualización: 26 de
          agosto de 2026.
        </p>

        <div className={`${cardClass} mt-6 space-y-6 text-sm leading-relaxed text-ink-200`}>
          <section>
            <h2 className="text-base font-semibold text-strong">1 · Quién responde por tus datos</h2>
            <p className="mt-1.5">
              Unify (unify-meet.com). Para cualquier consulta o pedido sobre tus datos:{" "}
              <a href="mailto:hola@unify-meet.com" className="text-brand-300 underline">
                hola@unify-meet.com
              </a>{" "}
              o WhatsApp{" "}
              <a href="https://wa.me/5491130254522" className="text-brand-300 underline" target="_blank" rel="noreferrer">
                11 3025-4522
              </a>{" "}
              (Argentina).
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">2 · Qué guardamos</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-strong">Tu cuenta:</span> email, nombre y foto de perfil (si
                elegís una). La contraseña no se guarda nunca: sólo un hash irreversible (scrypt) que ni
                nosotros podemos leer. Si entrás con Google, guardamos el email y nombre que Google nos da.
              </li>
              <li>
                <span className="font-medium text-strong">Tus reuniones:</span> la transcripción (quién dijo
                qué), el chat, las traducciones, los informes de IA y la grabación de audio/video cuando VOS la
                iniciás. Todo queda en tu historial, privado por cuenta.
              </li>
              <li>
                <span className="font-medium text-strong">Preferencias:</span> idioma de los subtítulos, roles
                asignados en la reunión y tu sesión iniciada (un token en tu navegador/extensión).
              </li>
              <li>
                <span className="font-medium text-strong">El portapapeles, sólo para detectar reuniones:</span>{" "}
                si le das permiso, la app mira tu portapapeles al abrirla para ver si copiaste un enlace de
                reunión y ofrecerte entrar con un toque. La lectura ocurre <span className="font-semibold">en
                tu propio dispositivo</span>: si no es un enlace de reunión, se descarta al instante y nunca se
                guarda ni se envía a ningún lado. Podés no dar el permiso (o quitarlo cuando quieras) y todo lo
                demás sigue funcionando igual.
              </li>
              <li>
                <span className="font-medium text-strong">Las páginas de reunión que abrís:</span> la
                extensión corre sólo en las páginas de videollamada conocidas (Zoom, Meet, Teams, Jitsi y las
                demás de la lista) para reconocer que estás entrando a una reunión y ofrecerte grabarla. En la
                página de Zoom que abre la app de escritorio, te ofrece unirte desde el navegador para que
                Unify pueda funcionar. No mira ninguna otra página que visites.
              </li>
              <li>
                <span className="font-medium text-strong">Lo que NO recolectamos:</span> historial de
                navegación, ubicación, contactos, datos de otros sitios. No hay analytics, ni trackers, ni
                cookies de publicidad — ni en la web ni en la extensión.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">3 · Para qué los usamos</h2>
            <p className="mt-1.5">
              Para una sola cosa: que veas y aproveches TUS reuniones — subtítulos, traducción, transcripción,
              grabación, informes y respuestas de la IA en tu historial. No usamos tus datos para publicidad,
              no los vendemos, no los cedemos a terceros ajenos al funcionamiento y no los usamos para ningún
              fin distinto del que estás viendo en pantalla.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">4 · Quiénes los procesan por nosotros</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-strong">Anthropic (Claude):</span> recibe la transcripción (y
                fotogramas del video, si le preguntás por lo que se vio) para traducir, resumir y responder tus
                preguntas. No usa tus datos para entrenar sus modelos.
              </li>
              <li>
                <span className="font-medium text-strong">Infraestructura:</span> servidor y base de datos en
                Render, grabaciones y fotos en Cloudflare R2, la web en Vercel, y los correos de verificación y
                recuperación salen por Resend. Cada uno ve sólo lo que necesita para su función.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">5 · Seguridad</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                <span className="font-medium text-strong">Cifrado en tránsito:</span> todo viaja por HTTPS/TLS
                — la web, la extensión, las grabaciones y los sockets en vivo.
              </li>
              <li>
                <span className="font-medium text-strong">Contraseñas y tokens:</span> contraseñas con hash
                scrypt (nunca en claro); los enlaces de verificación de email y de recuperación de contraseña
                usan tokens de un solo uso, guardados también hasheados y con vencimiento.
              </li>
              <li>
                <span className="font-medium text-strong">Sesiones bajo tu control:</span> al cambiar la
                contraseña se cierran todas las sesiones abiertas; también podés cerrarlas todas vos desde tu
                cuenta.
              </li>
              <li>
                <span className="font-medium text-strong">Contra ataques:</span> límites de intentos en el
                ingreso, el envío de correos y la IA (rate limiting), validación de todo lo que entra al
                servidor, y acceso al historial siempre verificado por cuenta: nadie ve reuniones ajenas.
              </li>
              <li>
                <span className="font-medium text-strong">En el navegador:</span> la web corre con cabeceras de
                seguridad estrictas (CSP, sin sniffing de tipos, sin embeberse en otros sitios) y la extensión
                no ejecuta código remoto: todo su código viaja en el paquete que revisa la tienda.
              </li>
              <li>
                <span className="font-medium text-strong">Si algo pasara:</span> ante un incidente que afecte
                tus datos, te avisamos por el correo de tu cuenta contándote qué pasó y qué hicimos.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">6 · Cuánto tiempo</h2>
            <p className="mt-1.5">
              Tus reuniones quedan en tu historial hasta que VOS las borres. Borrar una reunión elimina su
              transcripción, chat, informes y grabación. Si pedís eliminar tu cuenta, se elimina con todo su
              contenido.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">7 · Tus derechos y controles</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>Ver, descargar y borrar tus reuniones desde tu historial, cuando quieras.</li>
              <li>Cerrar la sesión en todos los dispositivos desde la configuración de tu cuenta.</li>
              <li>
                Pedirnos acceso, corrección o eliminación de tus datos por los contactos de arriba: respondemos
                y resolvemos el pedido.
              </li>
              <li>
                <span className="font-medium text-strong">Una responsabilidad tuya:</span> antes de grabar a
                otras personas, avisales — en varios países es obligación legal de quien graba.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">8 · La extensión, en particular</h2>
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              <li>
                Corre únicamente en páginas de reuniones (Google Meet, Zoom, Teams, Jitsi, Webex, Whereby,
                GoTo y las demás plataformas que reconoce) y en unify-meet.com. No lee tu navegación en ningún
                otro sitio.
              </li>
              <li>
                Trabaja de fondo mientras tu navegador está abierto —no necesita que la app de Unify esté
                abierta— pero SÓLO se activa cuando entrás a una de esas páginas de reunión. No vigila lo que
                hacés en el resto de tus pestañas ni en otras aplicaciones: los navegadores lo prohíben por
                diseño, y nosotros no lo intentamos.
              </li>
              <li>
                No graba ni transcribe nada sin decírtelo: siempre hay un aviso visible, y la captura de la
                pestaña sólo arranca con una acción tuya.
              </li>
              <li>
                Lo que capta (subtítulos, la grabación que iniciás) viaja cifrado al servidor de Unify y a
                ningún otro lado.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">9 · Menores y cambios</h2>
            <p className="mt-1.5">
              Unify no está dirigido a menores de 13 años y no recolectamos sus datos a sabiendas. Si esta
              política cambia, la fecha de arriba se actualiza y los cambios importantes se avisan en el sitio;
              ninguna modificación va a reducir tus derechos sobre datos ya guardados.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-strong">10 · Contacto</h2>
            <p className="mt-1.5">
              Dudas, pedidos sobre tus datos o reportes de seguridad:{" "}
              <a href="mailto:hola@unify-meet.com" className="text-brand-300 underline">
                hola@unify-meet.com
              </a>{" "}
              · WhatsApp{" "}
              <a href="https://wa.me/5491130254522" className="text-brand-300 underline" target="_blank" rel="noreferrer">
                11 3025-4522
              </a>{" "}
              · <Link to="/soporte" className="text-brand-300 underline">Centro de ayuda</Link>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
