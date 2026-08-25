// Envío de correo.
//
// Hasta acá el servidor no podía mandar un solo mail, y eso dejaba dos
// agujeros que no se cierran de ninguna otra forma: no había manera de probar
// que un email es tuyo, ni de volver a entrar si te olvidabas la contraseña.
//
// El transporte se elige por entorno y no agrega dependencias nuevas: Resend
// es una llamada HTTPS con fetch, igual que las que ya hace este servidor.
//
//   RESEND_API_KEY   -> se manda de verdad, por Resend.
//   MAIL_LOG=1       -> se imprime en la consola (desarrollo y pruebas).
//   nada configurado -> mailerEnabled = false.
//
// Ese último caso importa: sin correo configurado, la app NO finge. /api/auth/
// config informa que la verificación y la recuperación están apagadas, y la
// interfaz esconde los botones en vez de ofrecer algo que nunca va a llegar.

// El despliegue real guarda la clave como RESEND_API_KEY_MAIL (en ese entorno
// ya existía otra variable llamada RESEND_API_KEY): se acepta ese nombre
// primero y el clásico queda como respaldo -- cualquiera de los dos enciende
// el correo.
const RESEND_API_KEY = process.env.RESEND_API_KEY_MAIL?.trim() || process.env.RESEND_API_KEY?.trim();
const MAIL_LOG = process.env.MAIL_LOG === "1";

// Remitente. Con Resend tiene que ser un dominio verificado en la cuenta, si
// no la API rechaza el envío -- por eso se puede fijar por entorno.
const MAIL_FROM = process.env.MAIL_FROM?.trim() || "Unify <no-reply@unify-meet.com>";

export const mailerEnabled = Boolean(RESEND_API_KEY) || MAIL_LOG;

if (!mailerEnabled) {
  console.warn(
    "[mail] Sin RESEND_API_KEY_MAIL ni RESEND_API_KEY (ni MAIL_LOG=1): no se pueden enviar correos, " +
      "así que la verificación de email y la recuperación de contraseña quedan apagadas."
  );
} else if (RESEND_API_KEY) {
  console.log(`[mail] Resend configurado. Remitente: ${MAIL_FROM}`);
} else {
  console.log("[mail] MAIL_LOG=1: los correos se imprimen en esta consola, no se envían.");
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Versión de texto plano. Es la que se lee si el cliente no muestra HTML. */
  text: string;
  html: string;
}

// Un correo que tarda no puede colgar el pedido HTTP que lo disparó: quien se
// registra no debería quedarse mirando una ruedita porque el proveedor de
// correo está lento.
const SEND_TIMEOUT_MS = 10_000;

/** `true` si el correo salió. Nunca lanza: el flujo sigue aunque el mail falle. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  if (MAIL_LOG) {
    // Formato deliberadamente ruidoso y de una sola pieza: en desarrollo esto
    // es "la bandeja de entrada", y tiene que poder leerse de un vistazo.
    console.log(
      `\n[mail] ─────────────────────────────────────────\n` +
        `[mail] Para: ${message.to}\n` +
        `[mail] Asunto: ${message.subject}\n` +
        `${message.text
          .split("\n")
          .map((line) => `[mail] ${line}`)
          .join("\n")}\n` +
        `[mail] ─────────────────────────────────────────\n`
    );
    if (!RESEND_API_KEY) return true;
  }
  if (!RESEND_API_KEY) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[mail] Resend respondió ${res.status}: ${detail.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mail] No se pudo enviar:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
