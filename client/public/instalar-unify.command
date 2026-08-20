#!/bin/bash
# ==============================================================
#  Unify: instalador de la extensión para Chrome (macOS)
#  Es texto plano: leelo entero antes de ejecutarlo si querés.
#  Uso recomendado (pegar en Terminal):
#    curl -fsSL https://www.unify-meet.com/instalar-unify.command | bash
# ==============================================================
set -euo pipefail

BASE="${UNIFY_BASE:-https://www.unify-meet.com}"
DEST="$HOME/Library/Application Support/Unify/extension"

echo ""
echo "  === Unify: instalador de la extensión ==="
echo ""
echo "  Descargando la última versión…"
TMPZIP="$(mktemp -d)/unify-extension.zip"
curl -fsSL "$BASE/unify-extension.zip" -o "$TMPZIP"
mkdir -p "$DEST"
unzip -oq "$TMPZIP" -d "$DEST"

# La ruta al portapapeles (pbcopy sólo existe en macOS; afuera no pasa nada).
printf '%s' "$DEST" | pbcopy 2>/dev/null || true

echo "  Lista: quedó instalada en:"
echo "    $DEST"
echo "  (la ruta ya está COPIADA al portapapeles)"
echo ""

open -a "Google Chrome" "chrome://extensions" 2>/dev/null \
  || open -a "Microsoft Edge" "edge://extensions" 2>/dev/null \
  || true

echo "  Últimos DOS pasos, en la pestaña que se acaba de abrir:"
echo "    1. Prendé el “Modo de desarrollador” (arriba a la derecha)"
echo "    2. Tocá “Cargar descomprimida” y pegá la ruta con ⌘V"
echo ""
echo "  Después entrá a cualquier reunión: Unify aparece solo."
echo ""
