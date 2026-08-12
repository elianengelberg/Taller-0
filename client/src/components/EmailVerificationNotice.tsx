import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { fetchAuthConfig, requestEmailVerification } from "../lib/api";

// Aviso para quien todavía no confirmó su email.
//
// No es un cartel decorativo: mientras la dirección no esté probada, no hay
// forma de recuperar la cuenta si se pierde la contraseña, y tampoco de
// demostrar que esa dirección es tuya si otra persona la escribió al
// registrarse. Por eso el texto dice para qué sirve, en vez de limitarse a
// "verificá tu email".
//
// Se esconde solo cuando no corresponde: cuenta ya verificada (entre ellas
// todas las de Google), sin sesión, o servidor sin correo configurado -- en
// ese último caso pedir la confirmación sería pedir algo imposible.
export default function EmailVerificationNotice({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchAuthConfig().then((c) => setEnabled(c.emailVerification));
  }, []);

  async function handleSend() {
    setSending(true);
    setStatus(null);
    const res = await requestEmailVerification();
    setSending(false);
    setStatus(
      res.error ??
        `Te mandamos el enlace a ${user?.email ?? "tu email"}. Puede tardar un par de minutos; si no llega, mirá el correo no deseado.`
    );
  }

  if (!user || user.emailVerified || !enabled) return null;

  return (
    <div
      className={`rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 ${className}`}
    >
      <p className="font-medium">Te falta confirmar tu email</p>
      <p className="mt-1 leading-relaxed text-amber-200/80">
        Mandamos un enlace a <span className="font-medium text-amber-100">{user.email}</span>.
        Confirmarlo es lo que te deja recuperar la cuenta si te olvidás la contraseña, y lo que
        prueba que esa dirección es tuya y de nadie más.
      </p>
      <button
        type="button"
        onClick={handleSend}
        disabled={sending}
        className="mt-2 font-semibold underline underline-offset-2 hover:text-amber-100 disabled:opacity-60"
      >
        {sending ? "Enviando…" : "Enviarme el enlace de nuevo"}
      </button>
      {status && <p className="mt-2 text-xs text-amber-200/80">{status}</p>}
    </div>
  );
}
