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

// La plantilla del correo.
//
// Un correo no es una página web: Gmail, Outlook y Apple Mail recortan el CSS
// moderno sin avisar. Por eso todo acá es deliberadamente "antiguo" -- tablas
// anidadas, estilos EN LÍNEA, nada de flex, grid ni clases -- que es lo único
// que se ve igual en los tres. Las concesiones que sí se hacen (border-radius,
// que Outlook de escritorio ignora) degradan a esquinas rectas, no a un correo
// roto.
//
// El código de 6 dígitos es el protagonista: caja propia, 34px, monoespaciado
// y con separación entre dígitos, para que se lea de un vistazo en el teléfono
// y se pueda copiar a mano sin equivocarse un 0 por una O.
function layout(params: {
  title: string;
  intro: string;
  code?: { value: string; caption: string };
  cta?: { label: string; url: string };
  vence?: string;
  footer: string;
}): string {
  const { title, intro, code, cta, vence, footer } = params;
  // Los dígitos van separados por un espacio fino: sin esto, en algunos
  // clientes "111111" se lee como un borrón.
  const digitos = code ? esc(code.value).split("").join("&#8202;") : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0b0d17;-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- Vista previa de la bandeja: lo que se lee ANTES de abrir el correo. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${
    code ? `Tu código de Unify es ${esc(code.value)}` : esc(title)
  }</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d17;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

        <!-- Marca -->
        <tr><td align="center" style="padding:0 0 22px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#6366f1;border-radius:12px;width:40px;height:40px;text-align:center;vertical-align:middle;font-size:22px;font-weight:800;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">U</td>
            <td style="padding-left:11px;font-size:20px;font-weight:700;color:#f5f6fb;letter-spacing:-0.2px;">Unify</td>
          </tr></table>
        </td></tr>

        <!-- Tarjeta -->
        <tr><td style="background:#141728;border:1px solid #262a45;border-radius:18px;padding:34px 32px;">
          <h1 style="margin:0 0 12px;font-size:23px;line-height:1.3;color:#f5f6fb;font-weight:700;">${esc(title)}</h1>
          <p style="margin:0 0 26px;font-size:15px;line-height:1.65;color:#b9bdd4;">${intro}</p>
          ${
            code
              ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
            <tr><td align="center" style="background:#0b1223;border:1px solid #2f3660;border-radius:14px;padding:22px 16px 18px;">
              <p style="margin:0 0 10px;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#8b90ad;font-weight:600;">${esc(code.caption)}</p>
              <p style="margin:0;font-size:34px;line-height:1.1;font-weight:700;color:#ffffff;letter-spacing:9px;font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;">${digitos}</p>
            </td></tr>
          </table>`
              : ""
          }
          ${
            cta
              ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>
            <td style="background:#6366f1;border-radius:12px;">
              <a href="${esc(cta.url)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${esc(cta.label)}</a>
            </td>
          </tr></table>
          <p style="margin:0 0 22px;font-size:12.5px;line-height:1.6;color:#8b90ad;">¿El botón no anda? Copiá y pegá este enlace:<br><span style="color:#a5a9c4;word-break:break-all;">${esc(cta.url)}</span></p>`
              : ""
          }
          ${
            vence
              ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;border-top:1px solid #262a45;">
            <tr><td style="padding-top:18px;font-size:13px;line-height:1.6;color:#8b90ad;">${vence}</td></tr>
          </table>`
              : ""
          }
        </td></tr>

        <!-- Pie -->
        <tr><td style="padding:20px 8px 0;">
          <p style="margin:0 0 14px;font-size:12.5px;line-height:1.65;color:#8b90ad;">${footer}</p>
          <p style="margin:0;font-size:11.5px;line-height:1.6;color:#5f6482;">
            Unify — subtítulos, transcripción y grabación para tus reuniones.<br>
            Este correo es automático: si necesitás ayuda, escribinos a
            <a href="mailto:hola@unify-meet.com" style="color:#7f86ab;">hola@unify-meet.com</a>.
          </p>
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
  /** Los 6 dígitos: el camino corto para quien lee el mail en el teléfono. */
  code: string;
  appOrigin: string;
}): Promise<boolean> {
  const url = `${params.appOrigin}/verificar-email#token=${params.token}`;
  const firstName = params.name.split(/\s+/)[0] || "Hola";
  return sendMail({
    to: params.to,
    subject: `${params.code} es tu código de Unify`,
    text:
      `${firstName}, confirmá que este email es tuyo para terminar de crear tu cuenta en Unify.\n\n` +
      `Tu código de verificación: ${params.code}\n\n` +
      `Escribilo en Unify, o abrí este enlace:\n${url}\n\n` +
      `El código y el enlace vencen en 24 horas.\n\n` +
      `Si vos no creaste ninguna cuenta en Unify, ignorá este correo: alguien usó tu email. ` +
      `Podés quedarte con esa cuenta desde "Olvidé mi contraseña" en ${params.appOrigin}/ingresar.`,
    html: layout({
      title: `${esc(firstName)}, confirmá tu email`,
      intro:
        "Con esto terminás de crear tu cuenta en Unify y podés entrar desde cualquier dispositivo. Escribí el código en la pantalla que dejaste abierta, o tocá el botón.",
      code: { value: params.code, caption: "Tu código de verificación" },
      cta: { label: "Confirmar mi email", url },
      vence: "⏳ El código y el enlace vencen en <strong style=\"color:#b9bdd4;\">24 horas</strong>.",
      footer:
        "Si vos no creaste ninguna cuenta en Unify, <strong style=\"color:#f0a2a2;\">ignorá este correo</strong>: alguien escribió tu dirección al registrarse. " +
        `Nadie puede usar tu email sin este código. Podés quedarte con esa cuenta usando “Olvidé mi contraseña” en <a href="${esc(params.appOrigin)}/ingresar" style="color:#a5b4fc;">Unify</a>.`,
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
        "Pediste volver a entrar a tu cuenta de Unify. Tocá el botón para elegir una contraseña nueva; al hacerlo se cierran todas las sesiones abiertas de tu cuenta.",
      // A propósito SIN código: cambiar la contraseña es la llave de la
      // cuenta, y un secreto de 256 bits en el enlace es mucho más difícil de
      // adivinar que seis dígitos. La comodidad va donde el riesgo es menor.
      cta: { label: "Elegir contraseña nueva", url },
      vence: "⏳ El enlace vence en <strong style=\"color:#b9bdd4;\">1 hora</strong> y sirve una sola vez.",
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
