import { useEffect, useState } from "react";
import { fetchAuthConfig, startGoogleLogin } from "../lib/api";
import { GoogleIcon } from "./icons";

// Only rendered once we know the server actually has Google OAuth configured
// -- otherwise clicking it would just hit a 503. Self-contained so Login and
// Register can both drop it in without each tracking the config fetch.
export default function GoogleButton() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig().then((config) => {
      if (!cancelled) setEnabled(config.googleEnabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  return (
    <>
      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-ink-700" />
        <span className="text-xs text-ink-500">o</span>
        <div className="h-px flex-1 bg-ink-700" />
      </div>
      <button
        type="button"
        onClick={startGoogleLogin}
        className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-ink-600 bg-white py-3 text-sm font-semibold text-ink-900 transition hover:bg-ink-100"
      >
        <GoogleIcon className="h-4 w-4 shrink-0" />
        Continuar con Google
      </button>
    </>
  );
}
