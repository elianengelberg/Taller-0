// Empaqueta la extensión en un ZIP y lo deja dentro del build de la web
// (dist/unify-extension.zip), así unify-meet.com siempre sirve la última
// versión de la extensión -- el MISMO archivo que se sube a la Chrome Web
// Store. Corre como paso final de `npm run build`, sin nada que recordar.
//
// El ZIP se escribe a mano (formato "store", sin compresión) para no sumar
// dependencias: los archivos de la extensión pesan ~100 KB en total y el
// formato ZIP sin compresión son tres estructuras y un CRC32. Chrome y la
// Web Store lo aceptan igual que uno comprimido.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aca = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(aca, "../../extension");
const OUT = path.resolve(aca, "../dist/unify-extension.zip");

// En Vercel, si el proyecto se configurara sin acceso a la raíz del repo, la
// carpeta no está: se avisa y NO se rompe el deploy de la web por esto.
if (!fs.existsSync(path.join(EXT, "manifest.json"))) {
  console.warn("[pack-extension] no encuentro extension/manifest.json: salteo el ZIP");
  process.exit(0);
}

// --- CRC32 (tabla estándar) --------------------------------------------------
const TABLA = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLA[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Qué entra al paquete ----------------------------------------------------
// Sólo lo que la extensión necesita para correr: nada de README ni papeles.
function listar(dir, base = "") {
  const out = [];
  for (const nombre of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, nombre);
    const rel = base ? `${base}/${nombre}` : nombre;
    if (fs.statSync(abs).isDirectory()) {
      // store/ es material de la FICHA (capturas para la Web Store), no
      // código de la extensión: no viaja en el paquete.
      if (rel === "store") continue;
      out.push(...listar(abs, rel));
      continue;
    }
    if (/\.(md|zip)$/i.test(nombre)) continue;
    out.push(rel);
  }
  return out;
}

const archivos = listar(EXT);
const partes = [];
const centrales = [];
let offset = 0;
const FECHA = 0x5821; // fecha DOS fija (2024-01-01): builds reproducibles

for (const rel of archivos) {
  const datos = fs.readFileSync(path.join(EXT, rel));
  const nombre = Buffer.from(rel, "utf8");
  const crc = crc32(datos);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // firma local
  local.writeUInt16LE(20, 4); // versión mínima
  local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
  local.writeUInt16LE(0, 8); // método: store
  local.writeUInt16LE(0, 10); // hora DOS
  local.writeUInt16LE(FECHA, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(datos.length, 18);
  local.writeUInt32LE(datos.length, 22);
  local.writeUInt16LE(nombre.length, 26);
  local.writeUInt16LE(0, 28);
  partes.push(local, nombre, datos);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(FECHA, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(datos.length, 20);
  central.writeUInt32LE(datos.length, 24);
  central.writeUInt16LE(nombre.length, 28);
  central.writeUInt32LE(offset, 42);
  centrales.push(Buffer.concat([central, nombre]));

  offset += 30 + nombre.length + datos.length;
}

const dirCentral = Buffer.concat(centrales);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(archivos.length, 8);
eocd.writeUInt16LE(archivos.length, 10);
eocd.writeUInt32LE(dirCentral.length, 12);
eocd.writeUInt32LE(offset, 16);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...partes, dirCentral, eocd]));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`[pack-extension] ${archivos.length} archivos -> ${OUT} (${kb} KB)`);
