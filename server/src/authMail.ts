// Los correos de la cuenta: verificar el email y recuperar la contraseña.
//
// El enlace apunta SIEMPRE a una página de la app, nunca a un endpoint del
// servidor. Dos motivos, los dos concretos:
//
//  1. Los escáneres de seguridad de muchos correos corporativos (Outlook,
//     antivirus) abren cada enlace del mensaje antes de que lo veas. Si el
//     enlace fuera un GET que consume el token, el escáner te quemaría el
//     token y al hacer clic ya no serviría. La página, en cambio, sólo lo
//     consume cuando el navegador ejecuta el fetch.
//  2. El token viaja en el FRAGMENTO (#token=), que nunca sale del navegador:
//     no aparece en los logs del servidor ni en la cabecera Referer si la
//     página después carga algo de afuera. Mismo criterio que el redirect de
//     Google (ver index.ts).
import { sendMail } from "./mailer";

/** Escapa para meter texto de una persona dentro del HTML del correo. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(params: { title: string; intro: string; cta?: { label: string; url: string }; footer: string }): string {
  const { title, intro, cta, footer } = params;
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#0b0d17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d17;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#141728;border:1px solid #262a45;border-radius:16px;padding:32px;">
        <tr><td>
          <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#f5f6fb;">Unify</p>
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#f5f6fb;">${esc(title)}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#b9bdd4;">${intro}</p>
          ${
            cta
              ? `<p style="margin:0 0 24px;"><a href="${esc(cta.url)}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:12px;">${esc(cta.label)}</a></p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#8b90ad;">Si el botón no funciona, copiá y pegá este enlace en el navegador:<br><span style="color:#a5a9c4;word-break:break-all;">${esc(cta.url)}</span></p>`
              : ""
          }
          <p style="margin:0;font-size:13px;line-height:1.6;color:#8b90ad;">${footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Verificación del email al crear la cuenta.
 *
 * El párrafo final no es de relleno. Cualquiera puede escribir tu dirección en
 * el registro, así que este correo también le llega a quien NO creó la cuenta:
 * tiene que decirle, sin vueltas, que no toque el botón y cómo quedarse con la
 * cuenta que abrieron con su email.
 */
export function sendVerificationEmail(params: {
  to: string;
  name: string;
  token: string;
  appOrigin: string;
}): Promise<boolean> {
  const url = `${params.appOrigin}/verificar-email#token=${params.token}`;
  const firstName = params.name.split(/\s+/)[0] || "Hola";
  return sendMail({
    to: params.to,
    subject: "Confirmá tu email en Unify",
    text:
      `${firstName}, confirmá que este email es tuyo para terminar de crear tu cuenta en Unify.\n\n` +
      `${url}\n\n` +
      `El enlace vence en 24 horas.\n\n` +
      `Si vos no creaste ninguna cuenta en Unify, NO abras el enlace: alguien usó tu email. ` +
      `Podés quedarte con esa cuenta desde "Olvidé mi contraseña" en ${params.appOrigin}/ingresar.`,
    html: layout({
      title: `${esc(firstName)}, confirmá tu email`,
      intro:
        "Con esto terminás de crear tu cuenta en Unify y podés entrar desde cualquier dispositivo. El enlace vence en 24 horas.",
      cta: { label: "Confirmar mi email", url },
      footer:
        "Si vos no creaste ninguna cuenta en Unify, <strong style=\"color:#f0a2a2;\">no abras el enlace</strong>: alguien usó tu dirección. " +
        `Podés quedarte con esa cuenta usando “Olvidé mi contraseña” en <a href="${esc(params.appOrigin)}/ingresar" style="color:#a5b4fc;">Unify</a>.`,
    }),
  });
}

/** Recuperación de contraseña de una cuenta que sí tiene contraseña propia. */
export function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  token: string;
  appOrigin: string;
}): Promise<boolean> {
  const url = `${params.appOrigin}/restablecer#token=${params.token}`;
  const firstName = params.name.split(/\s+/)[0] || "Hola";
  return sendMail({
    to: params.to,
    subject: "Restablecer tu contraseña de Unify",
    text:
      `${firstName}, pediste volver a entrar a tu cuenta de Unify. Elegí una contraseña nueva acá:\n\n` +
      `${url}\n\n` +
      `El enlace vence en 1 hora y sirve una sola vez.\n\n` +
      `Si no fuiste vos, ignorá este correo: tu contraseña actual sigue funcionando y nadie entró a tu cuenta.`,
    html: layout({
      title: `${esc(firstName)}, elegí una contraseña nueva`,
      intro:
        "Pediste volver a entrar a tu cuenta de Unify. El enlace vence en 1 hora y sirve una sola vez. Al usarlo se cierran todas las sesiones abiertas de tu cuenta.",
      cta: { label: "Elegir contraseña nueva", url },
      footer:
        "Si no fuiste vos, ignorá este correo: tu contraseña actual sigue funcionando y nadie entró a tu cuenta.",
    }),
  });
}

/**
 * Cuenta que entra sólo con Google.
 *
 * No tiene contraseña que restablecer -- y crearle una desde acá sería abrirle
 * una segunda puerta a una cuenta que hoy sólo abre Google. Así que el correo
 * explica dónde está el botón, que es lo que esa persona necesita saber.
 *
 * Se manda igual (en vez de no mandar nada) porque el endpoint responde lo
 * mismo para todos los emails: si acá no llegara nada, el silencio delataría
 * qué cuentas usan Google.
 */
export function sendGoogleOnlyResetEmail(params: {
  to: string;
  name: string;
  appOrigin: string;
}): Promise<boolean> {
  const url = `${params.appOrigin}/ingresar`;
  const firstName = params.name.split(/\s+/)[0] || "Hola";
  return sendMail({
    to: params.to,
    subject: "Tu cuenta de Unify entra con Google",
    text:
      `${firstName}, pediste recuperar tu contraseña de Unify, pero esta cuenta no tiene una: ` +
      `entra con "Continuar con Google".\n\n` +
      `${url}\n\n` +
      `Si te olvidaste la contraseña de tu cuenta de Google, se recupera en Google, no acá: ` +
      `https://accounts.google.com/signin/recovery\n\n` +
      `Si no fuiste vos quien lo pidió, no hay nada que hacer: nadie entró a tu cuenta.`,
    html: layout({
      title: `${esc(firstName)}, esta cuenta entra con Google`,
      intro:
        "Pediste recuperar tu contraseña, pero esta cuenta no tiene una: se creó con Google y se abre desde el botón “Continuar con Google”.",
      cta: { label: "Ir a Unify e iniciar sesión", url },
      footer:
        "Si lo que olvidaste es la contraseña de tu cuenta de Google, se recupera en " +
        '<a href="https://accounts.google.com/signin/recovery" style="color:#a5b4fc;">Google</a>, no en Unify. ' +
        "Si no fuiste vos quien lo pidió, no hay nada que hacer: nadie entró a tu cuenta.",
    }),
  });
}
