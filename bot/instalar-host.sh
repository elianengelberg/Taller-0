#!/usr/bin/env bash
# Deja un droplet de Ubuntu (DigitalOcean) listo para correr el bot Notetaker:
# Node, el navegador de Playwright, y el audio virtual para que el bot ESCUCHE
# la reunión. Corré esto UNA vez en el droplet, como root o con sudo:
#
#   bash bot/instalar-host.sh
#
# Requisito: Ubuntu 22.04+ (el droplet más barato de DigitalOcean alcanza).
set -euo pipefail

echo "== 1/5  Paquetes del sistema =="
apt-get update -y
apt-get install -y curl git pulseaudio pulseaudio-utils

echo "== 2/5  Node.js 20 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 3/5  Dependencias del proyecto =="
# Corré este script DESDE la carpeta del repo ya clonado (git clone ...).
if [ ! -f "bot/joinbot.mjs" ]; then
  echo "Ejecutá esto desde la raíz del repo de Unify (donde está la carpeta bot/)." >&2
  exit 1
fi
npm --prefix client install --no-audit --no-fund >/dev/null 2>&1 || true

echo "== 4/5  Navegador de Playwright =="
npx --yes playwright install --with-deps chromium

echo "== 5/5  Audio virtual (para que el bot oiga la reunión) =="
# Un "parlante" virtual: lo que la reunión reproduce cae acá y el
# reconocimiento de voz lo puede tomar.
pulseaudio --start --exit-idle-time=-1 || true
pactl load-module module-null-sink sink_name=unify_sink sink_properties=device.description=UnifySink >/dev/null 2>&1 || true
pactl set-default-sink unify_sink >/dev/null 2>&1 || true

echo
echo "LISTO. El host quedó preparado."
echo
echo "Ahora, para probar (Jitsi primero, que no pide nada):"
echo '  MEETING_URL="https://meet.jit.si/UnaSalaDePrueba" \'
echo '  ROOM_KEY="jitsi:meet.jit.si/unasaladeprueba" \'
echo '  SERVER_URL="https://taller-0.onrender.com" \'
echo '  PLATFORM=jitsi BOT_NAME="Unify Notetaker" \'
echo '  node bot/joinbot.mjs'
echo
echo "Para Google Meet necesitás el perfil con la sesión de Google del bot"
echo "(ver bot/README.md, sección 3). Pasás BOT_PROFILE_DIR=/ruta/al/perfil."
