import { Component, ErrorInfo, ReactNode } from "react";
import Logo from "./Logo";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Without this, an uncaught render error anywhere below unmounts the whole
// React tree with nothing to replace it -- since <body> is styled near-black
// (bg-ink-950), that reads as an unexplained "black screen" with no way to
// tell what happened or recover, which is exactly what device-specific bugs
// (e.g. a WebRTC/media API quirk on a particular browser) look like from the
// outside. This turns that into a visible, recoverable error instead.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Error inesperado:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink-950 px-6 text-center">
          <Logo />
          <p className="mt-2 text-lg font-semibold text-strong">Uy, algo se rompió.</p>
          <p className="max-w-sm text-sm text-ink-300">
            Pasó un error inesperado y no pudimos seguir. Probá recargar la página -- si te
            vuelve a pasar, contá exactamente qué estabas haciendo (y en qué dispositivo/
            navegador) para poder arreglarlo.
          </p>
          {this.state.error.message && (
            <p className="max-w-sm break-words rounded-lg bg-ink-900 px-3 py-2 font-mono text-xs text-ink-500">
              {this.state.error.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-brand-600"
          >
            Volver al inicio
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
