import { useEffect, useState } from "react";

// ¿La pantalla quedó chica? (Split View o Slide Over en el iPad, una ventana
// angosta en la compu, un teléfono.) Cuando pasa, lo único que la persona
// quiere ver son los SUBTÍTULOS: todo lo demás -- cabeceras, botones grandes,
// consejos -- los empuja fuera de la vista, que es exactamente lo que pasaba
// al achicar la ventana al lado de Meet.
//
// Se mide el viewport real (no el aparato): la misma tablet es "grande" en
// pantalla completa y "chica" en Split View, y tiene que cambiar sola al
// arrastrar el divisor.
export const ALTO_CHICO = 600;
export const ANCHO_CHICO = 560;

export function pantallaChica(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerHeight < ALTO_CHICO || window.innerWidth < ANCHO_CHICO;
}

export function usePantallaChica(): boolean {
  const [chica, setChica] = useState(pantallaChica);
  useEffect(() => {
    const mirar = () => setChica(pantallaChica());
    mirar();
    window.addEventListener("resize", mirar);
    window.addEventListener("orientationchange", mirar);
    // El teclado en pantalla y las barras del navegador cambian el alto sin
    // disparar `resize` en iOS: visualViewport sí lo cuenta.
    window.visualViewport?.addEventListener("resize", mirar);
    return () => {
      window.removeEventListener("resize", mirar);
      window.removeEventListener("orientationchange", mirar);
      window.visualViewport?.removeEventListener("resize", mirar);
    };
  }, []);
  return chica;
}
