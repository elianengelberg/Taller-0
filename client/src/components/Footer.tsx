import { Link } from "react-router-dom";
import { LogoMark } from "./Logo";
import { MailIcon, WhatsAppIcon } from "./icons";

// El pie de página del sitio, al estilo Discord: una banda con degradado
// (navy -> azul) que ocupa el ancho completo, columnas de enlaces, la fila de
// contacto, y la MARCA GIGANTE recortada abajo de todo. Siempre en texto claro
// (es una banda de color, igual en tema claro y oscuro). Se monta en las
// páginas de contenido (no en las de reunión a pantalla completa).
export default function Footer() {
  const anio = new Date().getFullYear();
  const col = "text-[15px] text-white/70 transition-colors hover:text-white";
  const titulo = "text-sm font-semibold text-white/50";
  return (
    <footer className="relative mt-16 overflow-hidden bg-gradient-to-b from-[#141d33] via-[#2b3aa6] to-[#4a5cf0]">
      <div className="relative z-10 mx-auto max-w-6xl px-6 pt-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          {/* Marca + contacto */}
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2">
              <LogoMark className="h-9 w-9" />
              <span className="text-xl font-bold tracking-tight text-white">Unify</span>
            </div>
            <p className="mt-4 max-w-xs text-[15px] leading-relaxed text-white/70">
              Subtítulos, traducción y resumen en cada reunión. En Zoom, Meet, Teams o acá mismo.
            </p>
            <div className="mt-5">
              <p className={titulo}>Contacto</p>
              <div className="mt-3 flex items-center gap-3">
                <a
                  href="mailto:hola@unify-meet.com"
                  aria-label="Escribinos por mail"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <MailIcon className="h-5 w-5" />
                </a>
                <a
                  href="https://wa.me/5491130254522"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Escribinos por WhatsApp"
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <WhatsAppIcon className="h-5 w-5" />
                </a>
              </div>
            </div>
          </div>

          <div>
            <h3 className={titulo}>Producto</h3>
            <ul className="mt-4 space-y-3">
              <li><Link to="/" className={col}>Inicio</Link></li>
              <li><Link to="/instalar" className={col}>Instalar</Link></li>
              <li><Link to="/crear" className={col}>Crear una reunión</Link></li>
              <li><Link to="/externa" className={col}>Unirme con un enlace</Link></li>
            </ul>
          </div>

          <div>
            <h3 className={titulo}>Soporte</h3>
            <ul className="mt-4 space-y-3">
              <li><Link to="/soporte" className={col}>Centro de ayuda y contacto</Link></li>
              <li><Link to="/privacidad" className={col}>Privacidad</Link></li>
              <li><a href="mailto:hola@unify-meet.com" className={col}>hola@unify-meet.com</a></li>
            </ul>
          </div>

          <div>
            <h3 className={titulo}>Cuenta</h3>
            <ul className="mt-4 space-y-3">
              <li><Link to="/ingresar" className={col}>Iniciar sesión</Link></li>
              <li><Link to="/registrarse" className={col}>Crear cuenta</Link></li>
              <li><Link to="/historial" className={col}>Mis reuniones</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-2 border-t border-white/15 py-6 text-xs text-white/50 sm:flex-row">
          <p>© {anio} Unify. Todos los derechos reservados.</p>
          <p>Hecho para que las reuniones se entiendan.</p>
        </div>
      </div>

      {/* La marca recortada abajo como firma visual, pero discreta (no gigante). */}
      <div
        aria-hidden
        className="pointer-events-none select-none px-4 pt-2 text-center font-display font-extrabold leading-[0.8] tracking-tight text-white/10"
        style={{ fontSize: "clamp(2.5rem, 11vw, 7rem)" }}
      >
        Unify
      </div>
    </footer>
  );
}
