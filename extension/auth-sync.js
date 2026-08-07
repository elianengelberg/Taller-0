// Puente de sesión: corre en las páginas de Unify (no en Meet).
//
// El asistente de IA cuesta dinero por pregunta, así que el servidor exige una
// cuenta. En vez de pedirle al usuario que copie y pegue un token (algo que
// nadie hace bien), esta pieza lee la sesión que YA tiene abierta en la web de
// Unify y se la pasa a la extensión. El usuario solo inicia sesión una vez, en
// la página normal, y la IA aparece funcionando dentro de Meet.
//
// Solo se lee el identificador de sesión de Unify, de su propio sitio. Nada más.

(() => {
  const KEY = "encuentro_token";

  function push() {
    let token = null;
    try {
      token = localStorage.getItem(KEY);
    } catch {
      return; // almacenamiento bloqueado
    }
    try {
      chrome.runtime.sendMessage({ kind: "unify-token", token: token || null });
    } catch {
      /* la extensión se recargó: se reintenta en el próximo evento */
    }
  }

  push();
  // Iniciar o cerrar sesión en otra pestaña también actualiza la extensión.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) push();
  });
  // Y una pasada al volver a la pestaña, por si el login ocurrió en esta misma.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") push();
  });
  setTimeout(push, 2500);
})();
