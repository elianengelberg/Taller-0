// TEXTO GRANDE, para toda la app. Un interruptor (recordado entre visitas)
// que agranda la letra de TODAS las pantallas de una vez: como casi todos los
// tamaños están en rem, alcanza con agrandar la raíz. Es la salida para quien
// ve chico -- abuelos, gente sin anteojos a mano, una tele lejos -- sin
// tocar la configuración del sistema ni el zoom del navegador.
const CLAVE = "unify_texto_grande";
const EVENTO = "unify-texto-grande";

export function textoGrandeActivo(): boolean {
  try {
    return localStorage.getItem(CLAVE) === "1";
  } catch {
    return false;
  }
}

export function aplicarTextoGrande(activo: boolean = textoGrandeActivo()): void {
  document.documentElement.classList.toggle("texto-grande", activo);
}

export function fijarTextoGrande(activo: boolean): void {
  try {
    localStorage.setItem(CLAVE, activo ? "1" : "0");
  } catch {
    /* modo privado: vale por esta visita */
  }
  aplicarTextoGrande(activo);
  window.dispatchEvent(new Event(EVENTO));
}

export function alCambiarTextoGrande(cb: () => void): () => void {
  window.addEventListener(EVENTO, cb);
  return () => window.removeEventListener(EVENTO, cb);
}
