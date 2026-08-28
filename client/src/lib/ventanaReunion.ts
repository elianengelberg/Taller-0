// La pestaña que abre la reunión REAL (Meet, Zoom, etc.) desde el companion.
//
// En iPhone/iPad el enlace se lo lleva la APP: iOS intercepta la navegación
// y la pestaña de Safari queda huérfana en about:blank, al frente. Quien
// vuelve a Unify aterriza en una página en blanco y tiene que buscar la
// pestaña buena a mano. Acá se guarda la referencia para cerrar esa
// pestaña huérfana sola -- y SOLO si de verdad quedó en blanco: una
// reunión cargando o cargada es de otro origen y ni se puede leer.
let ventana: Window | null = null;
let abiertaEn = 0;

// Antes de esto, cerrar sería adelantarse: en compu la pestaña tarda un
// momento en cargar la reunión y mientras tanto TAMBIÉN está en blanco.
const GRACIA_MS = 3000;

function quedoEnBlanco(w: Window): boolean {
  try {
    // Legible sólo si sigue siendo el documento inicial (mismo origen).
    return w.location.href === "about:blank";
  } catch {
    return false; // ya navegó a la reunión: intocable
  }
}

export function abrirVentanaReunion(url: string) {
  cerrarVentanaSiQuedoEnBlanco();
  let w: Window | null = null;
  try {
    w = window.open(url, "_blank");
  } catch {
    w = null;
  }
  if (!w) return;
  // La protección de "noopener", pero conservando NUESTRA referencia: con
  // noopener el navegador devuelve null y la pestaña huérfana no se puede
  // cerrar nunca. Cortar opener a mano deja a la otra página sin acceso.
  try {
    (w as Window & { opener: unknown }).opener = null;
  } catch {
    // nada: la protección extra no es imprescindible
  }
  ventana = w;
  abiertaEn = Date.now();
  // Cierre automático armado DENTRO de la pestaña: si la app se llevó el
  // enlace, este documento inicial sobrevive y al volver a estar visible
  // se cierra solo (la persona aterriza directo en Unify). Si la reunión
  // llega a cargar, el documento inicial muere y el listener con él.
  try {
    w.document.addEventListener("visibilitychange", () => {
      try {
        if (
          w &&
          !w.closed &&
          Date.now() - abiertaEn > GRACIA_MS &&
          w.document.visibilityState === "visible" &&
          quedoEnBlanco(w)
        ) {
          w.close();
        }
      } catch {
        // la pestaña navegó o murió: no hay nada que cerrar
      }
    });
  } catch {
    // sin acceso al documento: queda el respaldo del companion
  }
}

// Respaldo: el companion lo llama cuando Unify vuelve a estar visible o
// recupera el foco. Si la pestaña de la reunión quedó en blanco (la app se
// llevó el enlace), se cierra para que el próximo regreso caiga en Unify.
export function cerrarVentanaSiQuedoEnBlanco() {
  const w = ventana;
  if (!w) return;
  try {
    if (w.closed) {
      ventana = null;
      return;
    }
    if (Date.now() - abiertaEn > GRACIA_MS && quedoEnBlanco(w)) {
      w.close();
      ventana = null;
    }
  } catch {
    // referencia inutilizable: soltarla
    ventana = null;
  }
}
