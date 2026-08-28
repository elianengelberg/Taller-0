import { useEffect, useRef, useState } from "react";

// ¿El sitio tiene el micrófono BLOQUEADO? El reconocimiento de voz "arranca"
// sin error aunque el permiso esté denegado (en iPhone/iPad siempre; en
// Chrome de escritorio con el permiso en "Bloquear" también), y la pantalla
// queda "Escuchando tu micrófono" mentirosa, sin una sola línea.
//
// Preguntarle el permiso al navegador permite avisar al instante con
// instrucciones -- y `onConcedido` dispara cuando el permiso llega, para
// relanzar el reconocimiento solo, sin recargar la página.
export function usePermisoDeMicrofono(reintento: number, onConcedido: () => void): boolean {
  const [bloqueado, setBloqueado] = useState(false);
  // La última versión del callback, para no re-suscribir el sondeo por él.
  const alConcederRef = useRef(onConcedido);
  alConcederRef.current = onConcedido;
  useEffect(() => {
    let vivo = true;
    let estado: PermissionStatus | null = null;
    void (async () => {
      try {
        const p = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
        if (!p || !vivo) return;
        estado = p;
        setBloqueado(p.state === "denied");
        p.onchange = () => {
          if (!vivo) return;
          setBloqueado(p.state === "denied");
          if (p.state === "granted") alConcederRef.current();
        };
      } catch {
        // navegador sin permissions.query de micrófono: seguimos sin sondeo
      }
    })();
    return () => {
      vivo = false;
      if (estado) estado.onchange = null;
    };
  }, [reintento]);
  return bloqueado;
}

export const MENSAJE_MIC_BLOQUEADO =
  "El micrófono está bloqueado para Unify, así que no podemos subtitular. Permitilo en el navegador (en iPhone/iPad: Ajustes → Apps → Safari o la app Unify → Micrófono) y tocá Reintentar.";

// Fuerza el CARTEL nativo de "¿Permitir el micrófono?". El reconocimiento de
// voz a veces arranca sin disparar el cartel (iOS), y la persona terminaba
// obligada a ir a Configuración sin que nadie le pidiera permiso de frente.
// Con el permiso ya dado resuelve en silencio; con el permiso bloqueado no
// hay cartel posible (regla del navegador) y ahí sí quedan los Ajustes.
export async function pedirCartelDeMicrofono(): Promise<"concedido" | "bloqueado" | "sin-audio"> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return "concedido";
  } catch (e) {
    const nombre = (e as DOMException)?.name || "";
    if (nombre === "NotAllowedError" || nombre === "SecurityError") return "bloqueado";
    return "sin-audio";
  }
}
