import { useEffect, useRef, useState } from "react";
import * as ReactNamespace from "react";
import * as ReactDOMNamespace from "react-dom";
import * as ReactDOMClientNamespace from "react-dom/client";
import Button from "./Button";
import { fetchZoomSignature } from "../lib/api";

// The Zoom embedded SDK ships as a UMD bundle that expects `React` and
// `ReactDOM` as GLOBALS (it lists them as externals). When Vite bundles it the
// UMD wrapper falls into its global branch and reads globalThis.React /
// globalThis.ReactDOM -- which don't exist in a normal ESM app, so it throws
// "React is not defined". We expose them just before loading the SDK. ReactDOM
// must carry both the classic API (render/createPortal) and createRoot (which
// moved to react-dom/client in React 18), since the UMD uses the same global
// for both slots.
function exposeReactGlobals(): void {
  const g = globalThis as unknown as { React?: unknown; ReactDOM?: unknown };
  if (!g.React) g.React = ReactNamespace;
  if (!g.ReactDOM) g.ReactDOM = { ...ReactDOMNamespace, ...ReactDOMClientNamespace };
}

interface Props {
  meetingNumber: string;
  passcode?: string;
  displayName: string;
  // Fired when the meeting connection closes (user left / meeting ended), so
  // the host page navigates away instead of leaving an empty frame -- mirrors
  // JitsiEmbed's onLeave.
  onLeave?: () => void;
}

// If we're still preparing after this long, something is wedged (Render cold
// start, a blocked SDK asset, a hung init). Turn the silent hang into an
// actionable error naming the exact phase we got stuck in.
const WATCHDOG_MS = 70_000;

// Zoom rejects join() with a { type, reason } object, not an Error, so pull the
// human-readable reason out when we can.
function zoomErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === "object") {
    const obj = e as { reason?: unknown; message?: unknown };
    if (typeof obj.reason === "string" && obj.reason.trim()) return obj.reason;
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

// Runs a real Zoom meeting embedded inside our layout via the official Meeting
// SDK for web (Component View). Like Jitsi, the meeting media lives inside the
// SDK's own DOM; our AI/transcription overlay works by listening to the user's
// OWN microphone (see ExternalMeeting), not by reaching into Zoom.
//
// Flow: ask our backend for a signed join token (the SDK secret never touches
// the browser) -> load the SDK from Zoom's CDN -> createClient/init/join. Once
// join() is invoked we HAND OFF to Zoom's own UI. Each phase is surfaced on
// screen and logged, and a watchdog converts a hang into a named error, so a
// stuck join is diagnosable instead of an infinite "Preparando…".
export default function ZoomEmbed({ meetingNumber, passcode, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Autorizando el ingreso a Zoom…");
  // "preparing": our overlay (signature + SDK load + init).
  // "in-zoom": handed off -- Zoom's own UI is showing.
  // "error": something failed; show the reason + a retry.
  const [status, setStatus] = useState<"preparing" | "in-zoom" | "error">("preparing");
  const [retry, setRetry] = useState(0);
  // The plain meeting passcode. Zoom's Web SDK ONLY accepts the plain passcode
  // (never the encrypted `pwd` from the link), so a wrong/blank one fails with
  // "contraseña incorrecta". We let the user enter/fix it inline on failure and
  // retry without leaving the page. Read via a ref so a retry picks up the
  // latest typed value without re-running the effect on every keystroke.
  const [localPasscode, setLocalPasscode] = useState(passcode ?? "");
  const passcodeRef = useRef(localPasscode);
  passcodeRef.current = localPasscode;

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    let disposed = false;
    let settled = false; // handed off or errored -- stop the watchdog acting
    let client: ZoomEmbeddedClient | null = null;
    const t0 = Date.now();
    let phaseText = "Autorizando el ingreso a Zoom…";
    const log = (m: string) => console.log(`[ZoomEmbed +${Date.now() - t0}ms] ${m}`);
    const step = (text: string) => {
      phaseText = text;
      if (!disposed) setPhase(text);
      log(text);
    };

    const fail = (msg: string) => {
      if (disposed || settled) return;
      settled = true;
      log(`ERROR: ${msg}`);
      setError(msg);
      setStatus("error");
    };
    const handOff = () => {
      if (disposed || settled) return;
      settled = true;
      log("handed off to Zoom UI");
      setStatus("in-zoom");
    };

    log(`start meeting=${meetingNumber} crossOriginIsolated=${window.crossOriginIsolated}`);

    const watchdog = window.setTimeout(() => {
      fail(
        `Zoom se quedó en: "${phaseText}". ` +
          (phaseText.startsWith("Autorizando")
            ? "El servidor puede estar despertando (Render tarda hasta ~1 min la primera vez). Probá reintentar."
            : "Puede ser un bloqueo del SDK de Zoom o de la red. Abrí la consola (F12) y contame qué error aparece.")
      );
    }, WATCHDOG_MS);

    async function start() {
      // 1. Signed join token from our server (503 if Zoom isn't configured).
      step("Autorizando el ingreso a Zoom…");
      const { signature, error: sigError } = await fetchZoomSignature(meetingNumber, 0);
      if (disposed) return;
      if (!signature) {
        fail(sigError ?? "No se pudo autorizar el ingreso a Zoom.");
        return;
      }
      log("got signature");

      // 2. Load the official SDK from the bundled npm package (code-split into
      //    its own chunk via dynamic import). We do NOT load it from Zoom's CDN
      //    <script> anymore: that external load was failing ("No se pudo cargar
      //    el SDK"). Bundling removes that failure point; the SDK still fetches
      //    its audio/video worker assets from source.zoom.us at runtime.
      step("Cargando el SDK de Zoom…");
      // Must run BEFORE the import: the UMD factory reads the globals at eval time.
      exposeReactGlobals();
      const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded")).default;
      if (disposed) return;
      if (!containerRef.current) {
        fail("No se pudo preparar el contenedor de Zoom.");
        return;
      }

      // 3. Init the embedded client. By default the Component View renders a
      //    small draggable popper (or nothing visible if the container isn't
      //    sized), so we pin the video to the container's real size and a fixed
      //    view so it fills the pane. patchJsMedia loads the media deps from
      //    Zoom's CDN.
      step("Iniciando Zoom…");
      const rect = containerRef.current.getBoundingClientRect();
      const width = Math.max(Math.floor(rect.width), 360);
      const height = Math.max(Math.floor(rect.height), 320);
      log(`container ${width}x${height}`);

      client = ZoomMtgEmbedded.createClient() as unknown as ZoomEmbeddedClient;
      await client.init({
        zoomAppRoot: containerRef.current,
        language: "es-ES",
        patchJsMedia: true,
        leaveOnPageUnload: true,
        customize: {
          video: {
            isResizable: false,
            viewSizes: { default: { width, height } },
            defaultViewType: "speaker",
          },
        },
      });
      if (disposed) return;
      log("init done");

      // Listeners must be registered AFTER init(); before init they no-op.
      client.on("connection-change", (payload) => {
        log(`connection-change: ${payload?.state ?? "?"} ${payload?.reason ?? ""}`);
        if (payload?.state === "Closed") onLeaveRef.current?.();
        else if (payload?.state === "Fail") {
          fail(payload?.reason || "Zoom no pudo conectar la reunión. Revisá la contraseña.");
        }
      });

      // 4. Hand off to Zoom's own UI so its connecting / waiting-room /
      //    connected / error states are visible instead of our overlay.
      step("Uniéndote a la reunión…");
      handOff();

      // Zoom's `password` expects the PLAIN passcode; the link's `pwd` is an
      // encrypted token that doesn't work, so we pass the plain passcode the
      // user typed (in the form or the inline retry field).
      const result = await client.join({
        signature,
        meetingNumber,
        password: passcodeRef.current.trim() || undefined,
        userName: displayName || "Invitado",
      });
      log(`join resolved: ${JSON.stringify(result)}`);
      if (!disposed && result && typeof result === "object" && "reason" in result) {
        fail(zoomErrorMessage(result, "No se pudo unir a la reunión de Zoom."));
      }
    }

    start().catch((e: unknown) => {
      console.error("[ZoomEmbed] fatal", e);
      fail(zoomErrorMessage(e, "No se pudo unir a la reunión de Zoom."));
    });

    return () => {
      disposed = true;
      window.clearTimeout(watchdog);
      try {
        client?.leaveMeeting();
      } catch {
        // Never joined / already gone -- nothing to clean up.
      }
    };
  }, [meetingNumber, passcode, displayName, retry]);

  if (status === "error") {
    const retryNow = () => {
      setError(null);
      setStatus("preparing");
      setPhase("Autorizando el ingreso a Zoom…");
      setRetry((n) => n + 1);
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-sm text-brand-300">{error}</p>
        <div className="w-full max-w-xs text-left">
          <label className="mb-1 block text-xs text-ink-300" htmlFor="zoom-inline-passcode">
            Contraseña de la reunión (texto, la que muestra Zoom — no el código del enlace)
          </label>
          <input
            id="zoom-inline-passcode"
            className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-brand-500"
            placeholder="Ej: 123456"
            value={localPasscode}
            onChange={(e) => setLocalPasscode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && retryNow()}
            autoFocus
          />
        </div>
        <Button onClick={retryNow}>Reintentar</Button>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {status === "preparing" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-ink-300">{phase}</p>
        </div>
      )}
    </div>
  );
}
