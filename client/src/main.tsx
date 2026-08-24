import "./polyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { initPwa } from "./pwa";
import { despertarServidor } from "./lib/api";
import "./index.css";

initPwa();
// El servidor gratuito de Render se apaga tras un rato sin visitas. Se lo
// despierta APENAS abre la app -- sin esperar respuesta -- así termina de
// levantarse mientras la persona lee la pantalla de inicio, en vez de
// hacerla esperar recién cuando aprieta un botón.
despertarServidor();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
