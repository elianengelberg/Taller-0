// Regenera las copias del código COMPARTIDO (detector de idioma y recorte de
// repetidos) para el servidor (TS) y la extensión (JS plano) desde
// client/src/lib/. Lo corre pack-extension.mjs en cada build;
// pruebas/sim_idioma.ts y pruebas/sim_repetidos.ts comprueban que las tres
// copias digan lo mismo.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const aviso = (origen) => `// Copia GENERADA por client/scripts/sync-compartido.mjs desde ${origen}: no editar acá.\n`;

// TS → JS plano con el propio compilador de TypeScript (nada de regex
// frágiles): se transpila a ES2020 y se sacan los `export` (un content
// script no tiene módulos).
import ts from "typescript";
function aJs(fuente) {
  const { outputText } = ts.transpileModule(fuente, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, removeComments: false },
  });
  return outputText.replace(/^export /gm, "");
}

for (const [nombre, exportado] of [["idioma", "{ detectarIdioma, idiomaEfectivo, crearMemoriaDeIdioma }"], ["repetidos", "{ recortarRepetido, crearMemoriaDeRepetidos }"]]) {
  const origen = `client/src/lib/${nombre}.ts`;
  const fuente = readFileSync(path.join(raiz, origen), "utf8");
  writeFileSync(path.join(raiz, `server/src/${nombre}.ts`), aviso(origen) + fuente);
  const js = aviso(origen) + aJs(fuente) + `
// Un content script no tiene módulos: se cuelga de window para content.js y
// prompt-injector.js (que corren después, ver manifest.json).
window.__unify${nombre[0].toUpperCase()}${nombre.slice(1)} = ${exportado};
`;
  writeFileSync(path.join(raiz, `extension/${nombre}.js`), js);
}
console.log("[sync-compartido] server/src/{idioma,repetidos}.ts y extension/{idioma,repetidos}.js regenerados");
