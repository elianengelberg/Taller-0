import { useEffect } from "react";

// Pone el título de la pestaña por página ("Instalar · Unify", "Historial ·
// Unify"), como cualquier web: ayuda a ubicarse entre pestañas y a los
// marcadores. Al desmontar vuelve al título base.
const BASE = "Unify — Reuniones sin barreras";

export function useDocumentTitle(titulo: string): void {
  useEffect(() => {
    document.title = titulo ? `${titulo} · Unify` : BASE;
    return () => {
      document.title = BASE;
    };
  }, [titulo]);
}
