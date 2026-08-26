// Integraciones de salida: cuando una reunión termina y tiene su resumen, se
// puede empujar a un webhook (Slack, Discord, Zapier, Make, o cualquier
// endpoint que reciba JSON). Es lo que Read AI vende como "manda tus recaps a
// Slack/Notion/CRM": un canal de la empresa recibe las notas de cada reunión,
// solo, sin que nadie las copie a mano.
//
// Se enciende con SUMMARY_WEBHOOK_URL (una sola URL a nivel del despliegue,
// que es justo lo que quiere una empresa: todo a su canal). Sin esa variable,
// esto es un no-op silencioso -- nada cambia para quien no la use.
//
// El formato del cuerpo cubre a los tres grandes de un saque:
//   { text: "..." }  -> Slack y Discord lo muestran como mensaje.
//   { report, ... }  -> Zapier/Make/webhooks propios tienen los campos sueltos.

const WEBHOOK_URL = process.env.SUMMARY_WEBHOOK_URL?.trim();
const APP_BASE = (process.env.APP_BASE_URL || "https://www.unify-meet.com").replace(/\/+$/, "");

export const summaryWebhookEnabled = Boolean(WEBHOOK_URL);

export interface ResumenMeta {
  meetingDbId: string;
  hostName: string;
  startedAt?: string;
}

// Empuja el resumen al webhook configurado. Best-effort y con timeout: una
// integración caída JAMÁS puede frenar ni voltear el cierre de la reunión.
export async function enviarResumenAWebhook(report: string, meta: ResumenMeta): Promise<boolean> {
  if (!WEBHOOK_URL) return false;
  const enlace = `${APP_BASE}/historial/${meta.meetingDbId}`;
  const titulo = `📝 Notas de la reunión de ${meta.hostName}`;
  // Slack/Discord recortan mensajes larguísimos; el resumen entero vive en el
  // enlace, así que al chat va un extracto y el link al detalle completo.
  const extracto = report.length > 2500 ? `${report.slice(0, 2500)}\n\n…(sigue)` : report;
  const cuerpo = {
    // Slack + Discord:
    text: `*${titulo}*\n\n${extracto}\n\n🔗 ${enlace}`,
    // Campos sueltos para Zapier/Make/webhooks propios:
    report,
    meetingUrl: enlace,
    hostName: meta.hostName,
    startedAt: meta.startedAt ?? null,
  };
  const controlador = new AbortController();
  const t = setTimeout(() => controlador.abort(), 10_000);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: controlador.signal,
    });
    return res.ok;
  } catch (err) {
    console.error("[integraciones] no se pudo enviar el resumen al webhook:", (err as Error).message);
    return false;
  } finally {
    clearTimeout(t);
  }
}
