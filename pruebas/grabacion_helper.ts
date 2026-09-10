// Corre las funciones REALES del servidor sobre la base de pruebas, para que
// la suite no pruebe una copia del SQL sino el código que corre en
// producción. Se usa desde sim_grabacion_ausente.js, que es una suite de
// navegador y no puede importar TypeScript del servidor.
//
//   tsx pruebas/grabacion_helper.ts adjuntar <dbId> <url>
//   tsx pruebas/grabacion_helper.ts anotar   <dbId> <nota>
//   tsx pruebas/grabacion_helper.ts leer     <dbId>
import { anotarGrabacion, attachRecording, getMeetingDetailRaw } from "/home/user/Taller-0/server/src/db";

const [, , accion, dbId, valor] = process.argv;

async function main() {
  if (accion === "adjuntar") await attachRecording(dbId, valor, 12_000);
  if (accion === "anotar") await anotarGrabacion(dbId, valor);
  const d = await getMeetingDetailRaw(dbId);
  console.log(JSON.stringify({ recordingUrl: d?.recordingUrl ?? null, recordingNote: d?.recordingNote ?? null }));
}

main().then(() => process.exit(0));
