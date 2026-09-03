// Los subtítulos FLOTANTES: la ventanita que queda encima de todo (PiP de
// documento en Chrome de escritorio) y el video flotante dibujado desde un
// canvas (iPhone, iPad, Android, y navegadores sin PiP de documento). Las dos
// muestran lo mismo y con las mismas reglas de lectura A DISTANCIA:
//   - la traducción es la lectura principal; el original va debajo, chico;
//   - la última frase se destaca (más grande, más negra) y las anteriores
//     quedan atenuadas;
//   - lo que se está diciendo ahora mismo va en cursiva, con un cursor;
//   - el tamaño del texto ESCALA con la ventana (agrandás la ventanita y
//     crece la letra) y además se ajusta con A− / A+, que se recuerda.
export interface FraseFlotante {
  quien: string;
  /** Lo que se lee: la traducción si hay, si no el original. */
  texto: string;
  /** El original, cuando `texto` es una traducción distinta. */
  original?: string;
  interina?: boolean;
}

const CLAVE_ESCALA = "unify_flotantes_escala";
export const ESCALA_MIN = 0.8;
export const ESCALA_MAX = 1.8;

export function escalaFlotantes(): number {
  try {
    const v = parseFloat(localStorage.getItem(CLAVE_ESCALA) ?? "");
    if (v >= ESCALA_MIN && v <= ESCALA_MAX) return v;
  } catch {
    /* modo privado: sin memoria */
  }
  return 1;
}

export function guardarEscalaFlotantes(v: number): number {
  const e = Math.min(ESCALA_MAX, Math.max(ESCALA_MIN, Math.round(v * 10) / 10));
  try {
    localStorage.setItem(CLAVE_ESCALA, String(e));
  } catch {
    /* modo privado: vale sólo por esta vez */
  }
  return e;
}

export const TEXTO_ESPERANDO = "Apenas alguien hable, los subtítulos (con su traducción) aparecen acá.";

// El CSS de la ventanita. El tamaño base sale del ALTO de la ventana (vh):
// agrandarla agranda la letra. --escala es el ajuste manual (A− / A+).
export function estiloFlotantes(): string {
  return `
    html { font-size: calc(clamp(15px, 6.5vh, 40px) * var(--escala, 1)); }
    body { margin: 0; background: #0b1020; color: #fff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    #subs { display: flex; flex-direction: column; justify-content: flex-end; gap: .4rem; height: 100vh; padding: .5rem .8rem .55rem; box-sizing: border-box; }
    .fila { font-size: 1rem; line-height: 1.28; opacity: .62; overflow: hidden; }
    .fila.ultima { font-size: 1.22rem; opacity: 1; }
    .fila.interina { font-style: italic; opacity: .8; }
    .quien { color: #8fb4ff; font-weight: 700; margin-right: .3em; }
    .original { display: block; font-size: .68em; font-style: italic; color: #b9c4dc; margin-top: .05em; }
    .cursor { display: inline-block; width: .12em; height: .95em; margin-left: .15em; vertical-align: -.1em; background: #8fb4ff; animation: latir 1s infinite; }
    @keyframes latir { 50% { opacity: 0; } }
    .espera { font-size: 1rem; line-height: 1.35; color: #9fb3d8; }
    .tamano { position: absolute; top: .3rem; right: .4rem; display: flex; gap: .25rem; opacity: .55; }
    .tamano:hover, .tamano:focus-within { opacity: 1; }
    .tamano button { font: 700 13px/1 system-ui, sans-serif; color: #fff; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.25); border-radius: 8px; padding: 4px 8px; cursor: pointer; min-width: 34px; min-height: 28px; }
    .tamano button:hover { background: rgba(255,255,255,.22); }
  `;
}

// Arma la ventanita: estilos, contenedor y los botones A− / A+.
export function prepararVentanaFlotante(win: Window, titulo = "Subtítulos — Unify"): void {
  const doc = win.document;
  doc.title = titulo;
  const estilo = doc.createElement("style");
  estilo.textContent = estiloFlotantes();
  doc.head.appendChild(estilo);
  doc.documentElement.style.setProperty("--escala", String(escalaFlotantes()));
  const cont = doc.createElement("div");
  cont.id = "subs";
  doc.body.appendChild(cont);
  const tamano = doc.createElement("div");
  tamano.className = "tamano";
  const boton = (texto: string, etiqueta: string, delta: number) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = texto;
    b.title = etiqueta;
    b.setAttribute("aria-label", etiqueta);
    b.addEventListener("click", () => {
      const e = guardarEscalaFlotantes(escalaFlotantes() + delta);
      doc.documentElement.style.setProperty("--escala", String(e));
    });
    return b;
  };
  tamano.append(boton("A−", "Texto más chico", -0.1), boton("A+", "Texto más grande", 0.1));
  doc.body.appendChild(tamano);
}

// Pinta las frases en la ventanita. Siempre por textContent: lo dicho en la
// reunión es texto, nunca HTML.
export function pintarFlotantesEnDocumento(doc: Document, frases: FraseFlotante[], maximo = 3): void {
  const cont = doc.getElementById("subs");
  if (!cont) return;
  cont.textContent = "";
  if (frases.length === 0) {
    const espera = doc.createElement("div");
    espera.className = "espera";
    espera.textContent = TEXTO_ESPERANDO;
    cont.appendChild(espera);
    return;
  }
  const visibles = frases.slice(-maximo);
  visibles.forEach((f, i) => {
    const fila = doc.createElement("div");
    fila.className = "fila" + (i === visibles.length - 1 ? " ultima" : "") + (f.interina ? " interina" : "");
    const quien = doc.createElement("span");
    quien.className = "quien";
    quien.textContent = `${f.quien}:`;
    const texto = doc.createElement("span");
    texto.textContent = f.texto;
    fila.append(quien, texto);
    if (f.interina) {
      const c = doc.createElement("span");
      c.className = "cursor";
      fila.appendChild(c);
    }
    if (f.original && f.original !== f.texto) {
      const o = doc.createElement("span");
      o.className = "original";
      o.textContent = f.original;
      fila.appendChild(o);
    }
    cont.appendChild(fila);
  });
}

// El video flotante (sin PiP de documento): las frases se dibujan en un
// canvas, fondo blanco Unify, de abajo hacia arriba. Última frase grande y
// negra; las anteriores más chicas y grises; el original debajo, chico.
export function pintarFlotantesEnCanvas(canvas: HTMLCanvasElement, frases: FraseFlotante[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const escala = escalaFlotantes() * (W / 1200);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const margen = 36 * (W / 1200);
  const ancho = W - margen * 2;
  if (frases.length === 0) {
    ctx.font = `600 ${Math.round(34 * escala)}px system-ui, sans-serif`;
    ctx.fillStyle = "#2563EB";
    ctx.fillText("Unify — subtítulos flotantes", margen, H / 2 - 22 * escala);
    ctx.font = `${Math.round(30 * escala)}px system-ui, sans-serif`;
    ctx.fillStyle = "#475569";
    ctx.fillText("Apenas alguien hable, las frases aparecen acá.", margen, H / 2 + 26 * escala);
    return;
  }
  let y = H - 24 * escala;
  const orden = [...frases.slice(-3)].reverse(); // de la más nueva a la más vieja
  for (let i = 0; i < orden.length; i++) {
    const f = orden[i];
    const ultima = i === 0;
    const tam = Math.round((ultima ? 44 : 32) * escala);
    const tamOrig = Math.round(26 * escala);
    const tamQuien = Math.round((ultima ? 26 : 22) * escala);
    // Se dibuja de abajo hacia arriba: primero el original (que va debajo).
    if (f.original && f.original !== f.texto) {
      ctx.font = `italic ${tamOrig}px system-ui, sans-serif`;
      ctx.fillStyle = "#64748b";
      const ro = partirEnRenglones(ctx, f.original, ancho);
      for (let j = ro.length - 1; j >= 0; j--) {
        if (y < 40) return;
        ctx.fillText(ro[j], margen, y);
        y -= tamOrig * 1.25;
      }
      y -= 4 * escala;
    }
    ctx.font = `${f.interina ? "italic " : ""}${ultima ? "600 " : ""}${tam}px system-ui, sans-serif`;
    ctx.fillStyle = f.interina ? "#64748b" : ultima ? "#0f172a" : "#334155";
    const renglones = partirEnRenglones(ctx, f.texto, ancho);
    for (let j = renglones.length - 1; j >= 0; j--) {
      if (y < 40) return;
      ctx.fillText(renglones[j], margen, y);
      y -= tam * 1.22;
    }
    if (y < 40) return;
    ctx.font = `700 ${tamQuien}px system-ui, sans-serif`;
    ctx.fillStyle = "#2563EB";
    ctx.fillText(f.quien, margen, y);
    y -= tamQuien * 1.7;
  }
}

export function partirEnRenglones(ctx: CanvasRenderingContext2D, texto: string, ancho: number): string[] {
  const palabras = texto.split(/\s+/);
  const lineas: string[] = [];
  let actual = "";
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p;
    if (ctx.measureText(prueba).width > ancho && actual) {
      lineas.push(actual);
      actual = p;
    } else {
      actual = prueba;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}
