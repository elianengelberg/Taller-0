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
// The SDK is initialized exactly ONCE per mount (init loads media workers and
// a global PubSub that must not be double-loaded -- re-initing on a retry left
// the UI black). A retry (e.g. after a wrong passcode) reuses the same client
// and only calls join() again.
export default function ZoomEmbed({ meetingNumber, passcode, displayName, onLeave }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("Autorizando el ingreso a Zoom…");
  const [status, setStatus] = useState<"preparing" | "in-zoom" | "error">("preparing");
  const [retry, setRetry] = useState(0);
  // Plain passcode (Zoom's Web SDK never accepts the encrypted link `pwd`). The
  // user can fix it inline on failure; read via a ref so a retry uses the
  // latest value without re-running the effect on every keystroke.
  const [localPasscode, setLocalPasscode] = useState(passcode ?? "");
  const passcodeRef = useRef(localPasscode);
  passcodeRef.current = localPasscode;

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  // The embedded client persists across retries so we init once and only
  // re-join on retry.
  const clientRef = useRef<ZoomEmbeddedClient | null>(null);

  // Leave the meeting only when the component actually unmounts (not on retry).
  useEffect(() => {
    return () => {
      try {
        clientRef.current?.leaveMeeting();
      } catch {
        // never joined / already gone
      }
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let settled = false;
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

    log(`start meeting=${meetingNumber} crossOriginIsolated=${window.crossOriginIsolated} retry=${retry}`);

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

      // 2 + 3. Load + init the SDK ONCE. On a retry the client already exists,
      //         so we skip straight to re-joining (re-initing double-loads the
      //         media/PubSub globals and leaves the UI black).
      if (!clientRef.current) {
        step("Cargando el SDK de Zoom…");
        exposeReactGlobals();
        const ZoomMtgEmbedded = (await import("@zoom/meetingsdk/embedded")).default;
        if (disposed) return;
        if (!containerRef.current) {
          fail("No se pudo preparar el contenedor de Zoom.");
          return;
        }

        step("Iniciando Zoom…");
        const rect = containerRef.current.getBoundingClientRect();
        const width = Math.max(Math.floor(rect.width), 360);
        const height = Math.max(Math.floor(rect.height), 320);
        log(`container ${width}x${height}`);

        const client = ZoomMtgEmbedded.createClient() as unknown as ZoomEmbeddedClient;
        await client.init({
          zoomAppRoot: containerRef.current,
          language: "es-ES",
          patchJsMedia: true,
          leaveOnPageUnload: true,
          customize: {
            video: {
              isResizable: false,
              viewSizes: { default: { width, height } },
              // Gallery shows every participant as a tile (with their name even
              // if the camera is off), so the pane isn't a blank black frame.
              defaultViewType: "gallery",
            },
          },
        });
        if (disposed) return;
        log("init done");

        client.on("connection-change", (payload) => {
          log(`connection-change: ${payload?.state ?? "?"} ${payload?.reason ?? ""}`);
          if (payload?.state === "Closed") onLeaveRef.current?.();
          else if (payload?.state === "Fail") {
            fail(payload?.reason || "Zoom no pudo conectar la reunión. Revisá la contraseña.");
          }
        });

        clientRef.current = client;
      }

      // 4. Hand off to Zoom's own UI, then join.
      step("Uniéndote a la reunión…");
      handOff();

      const result = await clientRef.current.join({
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  if (status === "error") {
    const retryNow = () => {
      setError(null);
      setStatus("preparing");
      setPhase("Reintentando…");
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
