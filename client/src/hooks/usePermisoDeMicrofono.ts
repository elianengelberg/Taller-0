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

// Fuerza el CARTEL nativo de autorización. El reconocimiento de voz a veces
// arranca sin disparar el cartel (iOS), y la persona terminaba obligada a ir
// a Configuración sin que nadie le pidiera permiso de frente.
//
// Se piden micrófono Y cámara JUNTOS: un solo cartel que autoriza todo (y
// deja la cámara lista para las reuniones propias de Unify). Si la cámara
// falla -- bloqueada, o una compu sin webcam --, se reintenta con micrófono
// solo: los subtítulos no dependen de la cámara y no pueden caerse por ella.
// Con los permisos ya dados resuelve en silencio; con el permiso bloqueado
// no hay cartel posible (regla del navegador) y ahí sí quedan los Ajustes.
export async function pedirCartelDeMedios(): Promise<"concedido" | "bloqueado" | "sin-audio"> {
  for (const pedido of [{ audio: true, video: true }, { audio: true }] as const) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(pedido);
      for (const t of stream.getTracks()) t.stop();
      return "concedido";
    } catch (e) {
      if (!("video" in pedido)) {
        const nombre = (e as DOMException)?.name || "";
        if (nombre === "NotAllowedError" || nombre === "SecurityError") return "bloqueado";
        return "sin-audio";
      }
      // Falló el pedido con cámara: probar con el micrófono solo.
    }
  }
  return "sin-audio";
}
