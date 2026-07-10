import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ChevronDownIcon, LogoutIcon, SettingsIcon } from "./icons";
import AccountSettingsModal from "./AccountSettingsModal";

const menuItemClass =
  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink-200 hover:bg-ink-700";

// The header's account area: logged out it offers Ingresar / Crear cuenta;
// logged in, the greeting itself opens a dropdown with Configuración and
// Cerrar sesión -- "Salir" used to sit bare in the header and people read it
// as "go back", not "log out", which silently ended their session. Hiding
// the actual logout behind an explicit click removes that trap.
export default function AccountMenu() {
  const { user, logout, loading } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Avoid flashing the logged-out buttons while the stored token is still
  // being validated on first load.
  if (loading) return <div className="h-8" aria-hidden />;

  if (user) {
    return (
      <>
        <div ref={containerRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-full border border-ink-600 py-1 pl-1 pr-3 text-sm font-medium text-strong transition-colors hover:border-brand-400"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-xs font-bold text-on-accent">
              {initial(user.name)}
            </span>
            <span className="hidden sm:inline">
              Hola, <span className="font-semibold">{firstName(user.name)}</span>
            </span>
            <ChevronDownIcon className={`h-3.5 w-3.5 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          {open && (
            <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 shadow-soft">
              <button
                type="button"
                className={menuItemClass}
                onClick={() => {
                  setOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <SettingsIcon className="h-4 w-4 shrink-0" />
                Configuración
              </button>
              <button
                type="button"
                className={`${menuItemClass} text-red-300 hover:bg-red-500/10`}
                onClick={() => {
                  setOpen(false);
                  logout();
                  navigate("/");
                }}
              >
                <LogoutIcon className="h-4 w-4 shrink-0" />
                Cerrar sesión
              </button>
            </div>
          )}
        </div>

        {settingsOpen && <AccountSettingsModal onClose={() => setSettingsOpen(false)} />}
      </>
    );
  }

  return (
    <div className="flex items-center gap-3 sm:gap-4">
      <Link to="/ingresar" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-strong">
        Ingresar
      </Link>
      {/* Hidden on phones: together with the logo and Historial link this
          overflows a 390px-wide header, and the banner right below the
          header repeats both the login and register actions anyway. */}
      <Link
        to="/registrarse"
        className="hidden whitespace-nowrap rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-brand-600 sm:inline-block"
      >
        Crear cuenta
      </Link>
    </div>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}
