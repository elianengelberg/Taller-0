import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// The header's account area: logged out it offers Ingresar / Crear cuenta;
// logged in it greets the user and offers Salir.
export default function AccountMenu() {
  const { user, logout, loading } = useAuth();
  const navigate = useNavigate();

  // Avoid flashing the logged-out buttons while the stored token is still
  // being validated on first load.
  if (loading) return <div className="h-8" aria-hidden />;

  if (user) {
    return (
      <div className="flex items-center gap-3">
        <span className="hidden text-sm text-ink-300 sm:inline">
          Hola, <span className="font-medium text-white">{firstName(user.name)}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            logout();
            navigate("/");
          }}
          className="whitespace-nowrap rounded-lg border border-ink-600 px-3 py-1.5 text-sm font-medium text-ink-200 hover:border-red-400 hover:text-red-300"
        >
          Salir
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 sm:gap-4">
      <Link to="/ingresar" className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-white">
        Ingresar
      </Link>
      <Link
        to="/registrarse"
        className="whitespace-nowrap rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600"
      >
        Crear cuenta
      </Link>
    </div>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
