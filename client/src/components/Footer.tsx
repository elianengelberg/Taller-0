import { Link } from "react-router-dom";
import { LogoMark } from "./Logo";
import { MailIcon } from "./icons";

// El pie de página del sitio: la barra gruesa de otro color abajo de todo, con
// la marca, los enlaces y el contacto, como cualquier web actual. Se monta en
// las páginas de contenido (no en las de reunión a pantalla completa).
export default function Footer() {
  const anio = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t border-ink-700 bg-ink-900">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <LogoMark className="h-8 w-8" />
            <span className="text-lg font-bold tracking-tight text-strong">Unify</span>
          </div>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-400">
            Subtítulos, traducción y resumen en cada reunión. En Zoom, Meet, Teams o acá mismo.
          </p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Producto</h3>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link to="/" className="text-ink-300 hover:text-strong">Inicio</Link></li>
            <li><Link to="/instalar" className="text-ink-300 hover:text-strong">Instalar</Link></li>
            <li><Link to="/crear" className="text-ink-300 hover:text-strong">Crear una reunión</Link></li>
            <li><Link to="/externa" className="text-ink-300 hover:text-strong">Unirme con un enlace</Link></li>
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Soporte</h3>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link to="/soporte" className="text-ink-300 hover:text-strong">Centro de ayuda y contacto</Link></li>
            <li><Link to="/privacidad" className="text-ink-300 hover:text-strong">Privacidad</Link></li>
            <li>
              <a
                href="mailto:hola@unify-meet.com"
                className="inline-flex items-center gap-1.5 text-ink-300 hover:text-strong"
              >
                <MailIcon className="h-4 w-4" />
                hola@unify-meet.com
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Cuenta</h3>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link to="/ingresar" className="text-ink-300 hover:text-strong">Iniciar sesión</Link></li>
            <li><Link to="/registrarse" className="text-ink-300 hover:text-strong">Crear cuenta</Link></li>
            <li><Link to="/historial" className="text-ink-300 hover:text-strong">Mis reuniones</Link></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-ink-700">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-5 text-xs text-ink-500 sm:flex-row">
          <p>© {anio} Unify. Todos los derechos reservados.</p>
          <p>Hecho para que las reuniones se entiendan.</p>
        </div>
      </div>
    </footer>
  );
}
