// Bitácora del actualizador: un archivo de texto plano, chico, con lo que
// electron-updater fue haciendo (buscó, encontró, bajó, falló y POR QUÉ).
//
// Por qué existe: el actualizador fallaba en silencio. `autoUpdater` sin
// `logger` no deja rastro, y "no se actualiza" era imposible de diagnosticar
// a distancia. Con esto, el archivo cuenta la historia:
//   %APPDATA%\unify-escritorio\logs\actualizador.log
//
// Sin dependencias (electron-log no hace falta para cuatro líneas): se
// escribe con fs, y cuando pasa el tope se queda con la mitad más nueva.
const fs = require("fs");
const path = require("path");

const TOPE = 256 * 1024;

function crearBitacora(archivo, { tope = TOPE, reloj = () => new Date() } = {}) {
  let preparada = false;
  function preparar() {
    if (preparada) return;
    preparada = true;
    try { fs.mkdirSync(path.dirname(archivo), { recursive: true }); } catch { /* sin carpeta: se intenta igual */ }
  }
  function recortar() {
    let tam = 0;
    try { tam = fs.statSync(archivo).size; } catch { return; }
    if (tam <= tope) return;
    try {
      const texto = fs.readFileSync(archivo, "utf8");
      const desde = texto.indexOf("\n", Math.floor(texto.length / 2));
      fs.writeFileSync(archivo, desde >= 0 ? texto.slice(desde + 1) : "");
    } catch { /* si no se pudo recortar, sigue creciendo un rato más */ }
  }
  function linea(nivel, partes) {
    preparar();
    const texto = partes
      .map((p) => (p instanceof Error ? `${p.message}${p.code ? ` (${p.code})` : ""}` : typeof p === "string" ? p : safeJson(p)))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const fila = `${reloj().toISOString()} ${nivel.padEnd(5)} ${texto}\n`;
    try {
      fs.appendFileSync(archivo, fila);
      recortar();
    } catch { /* disco lleno o sin permisos: no puede tumbar la app */ }
    return fila;
  }
  return {
    ruta: archivo,
    info: (...p) => linea("info", p),
    warn: (...p) => linea("warn", p),
    error: (...p) => linea("error", p),
    // electron-updater llama a debug si existe; en el archivo no hace falta el
    // detalle byte a byte de cada descarga.
    debug: () => "",
  };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { crearBitacora, TOPE };
