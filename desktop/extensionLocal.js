// La copia LOCAL de la extensión, mantenida por la app de escritorio.
//
// La Chrome Web Store se actualiza sola, pero quien cargó la extensión por
// ZIP ("Cargar descomprimida") queda clavado en esa versión para siempre:
// Chrome no sabe de dónde salió la carpeta. Acá la app se hace cargo: guarda
// la extensión en SU carpeta de datos, compara la versión publicada en la web
// con la instalada, y cuando hay una nueva baja el ZIP y la reemplaza. La
// persona la carga en Chrome UNA vez desde esa carpeta; después, cada
// actualización de la app la deja fresca y Chrome la toma al reiniciarse.
//
// Sin Electron a propósito: puro Node, así se prueba de verdad en la suite
// (sim_escritorio) contra la web local, sin levantar ninguna ventana.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yauzl = require("yauzl");
const extract = require("extract-zip");

// Revisa el ZIP ANTES de abrirlo: ninguna entrada puede ser un enlace
// simbólico ni salirse de la carpeta. extract-zip no lo controla (tiene un
// aviso de seguridad conocido por symlinks). El ZIP es nuestro y viaja por
// HTTPS, pero una defensa así no cuesta nada y cierra el aviso.
function revisarZip(ruta) {
  return new Promise((resolve, reject) => {
    yauzl.open(ruta, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let entradas = 0;
      zip.on("entry", (e) => {
        entradas += 1;
        const nombre = String(e.fileName || "");
        const esSymlink = ((e.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
        const seSale =
          nombre.split("/").includes("..") ||
          path.isAbsolute(nombre) ||
          /^[a-zA-Z]:/.test(nombre) ||
          nombre.includes("\\");
        if (esSymlink || seSale || entradas > 500) {
          zip.close();
          reject(new Error(`zip rechazado: entrada sospechosa "${nombre}"`));
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => resolve(entradas));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

// Techo del ZIP: la extensión pesa ~200 KB; si el servidor devolviera
// cualquier otra cosa (una página de error, un redirect raro), no la
// escribimos como si fuera la extensión.
const MAX_ZIP_BYTES = 20 * 1024 * 1024;

function versionInstalada(carpeta) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(carpeta, "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Deja la carpeta `baseDir/extension` en la versión publicada en `web`.
 *
 * Devuelve { estado, version }:
 *   "al-dia"      ya estaba en la última
 *   "creada"      no existía y se instaló
 *   "actualizada" existía vieja y se reemplazó
 *   "error"       no se pudo (sin red, zip roto): la carpeta que había queda
 *                 intacta -- una extensión vieja funciona; una rota, no.
 */
async function refrescarExtension({ baseDir, web }) {
  const carpeta = path.join(baseDir, "extension");
  try {
    const r = await fetch(`${web}/version-extension.json`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`version-extension.json: HTTP ${r.status}`);
    const info = await r.json();
    const publicada = String(info.version || "");
    if (!publicada) throw new Error("version-extension.json sin version");
    // El sha256 del ZIP, publicado al lado de la versión: si viene, el ZIP
    // tiene que coincidir (un proxy que cambie bytes, una descarga cortada).
    const hashPublicado = typeof info.sha256 === "string" ? info.sha256.toLowerCase() : "";

    const instalada = versionInstalada(carpeta);
    if (instalada === publicada) return { estado: "al-dia", version: publicada };

    // Bajar el ZIP entero a un archivo temporal propio.
    const rz = await fetch(`${web}/unify-extension.zip`, { signal: AbortSignal.timeout(30_000) });
    if (!rz.ok) throw new Error(`unify-extension.zip: HTTP ${rz.status}`);
    const cuerpo = Buffer.from(await rz.arrayBuffer());
    if (cuerpo.length < 1000 || cuerpo.length > MAX_ZIP_BYTES) {
      throw new Error(`zip de tamaño sospechoso: ${cuerpo.length} bytes`);
    }
    if (hashPublicado) {
      const real = crypto.createHash("sha256").update(cuerpo).digest("hex");
      if (real !== hashPublicado) throw new Error("el zip no coincide con el sha256 publicado");
    }
    fs.mkdirSync(baseDir, { recursive: true });
    const zipTmp = path.join(baseDir, "extension-descarga.zip");
    fs.writeFileSync(zipTmp, cuerpo);

    // Extraer a una carpeta NUEVA y recién ahí tocar la instalada: si algo
    // falla a mitad de camino, la vieja sigue entera.
    const staging = path.join(baseDir, "extension-nueva");
    fs.rmSync(staging, { recursive: true, force: true });
    await revisarZip(zipTmp);
    await extract(zipTmp, { dir: staging });
    fs.rmSync(zipTmp, { force: true });
    if (!versionInstalada(staging)) throw new Error("el zip no trae un manifest válido");

    const habia = fs.existsSync(carpeta);
    try {
      // Camino rápido: intercambio atómico de carpetas.
      const vieja = path.join(baseDir, "extension-anterior");
      fs.rmSync(vieja, { recursive: true, force: true });
      if (habia) fs.renameSync(carpeta, vieja);
      fs.renameSync(staging, carpeta);
      fs.rmSync(vieja, { recursive: true, force: true });
    } catch {
      // Chrome puede tener archivos de la carpeta abiertos (Windows no deja
      // renombrar): se copia POR ENCIMA, que Chrome tolera, y la extensión
      // nueva entra al reiniciar el navegador.
      fs.cpSync(staging, carpeta, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return { estado: habia ? "actualizada" : "creada", version: publicada };
  } catch (err) {
    return { estado: "error", version: versionInstalada(carpeta), detalle: String(err?.message || err) };
  }
}

module.exports = { refrescarExtension, versionInstalada, revisarZip };
