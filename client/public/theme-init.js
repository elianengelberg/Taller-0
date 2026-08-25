// Aplica el tema guardado antes del primer pintado, para que nunca se vea el
// destello del tema equivocado. Después lo mantiene ThemeContext.
//
// Vive en un archivo propio y no como script inline dentro del HTML: la
// Content-Security-Policy de producción no permite scripts inline (que es lo
// que corta un XSS de raíz), así que inline este código simplemente no se
// ejecutaría y el destello volvería en cada carga.
(function () {
  try {
    // Sin elección guardada, el tema es el CLARO (decisión de producto:
    // la primera impresión es la pantalla clara). "auto" sigue existiendo,
    // pero sólo para quien lo elige en Ajustes.
    var t = localStorage.getItem("unify_theme") || "light";
    var d =
      t === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
    document.documentElement.dataset.theme = d;
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
