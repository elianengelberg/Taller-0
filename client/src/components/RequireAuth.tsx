import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import LoadingDots from "./LoadingDots";
import Logo from "./Logo";

// Wraps the private pages (the meeting history). While the stored session is
// being validated it shows a small loader; if there's no logged-in user it
// bounces to the login page, remembering where the user was headed.
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink-950">
        <Logo />
        <LoadingDots />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/ingresar" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}
