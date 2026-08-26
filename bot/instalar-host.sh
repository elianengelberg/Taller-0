#!/usr/bin/env bash
# Deja un droplet de Ubuntu (DigitalOcean) listo para correr el bot Notetaker:
# Node, el navegador de Playwright, y el audio virtual para que el bot ESCUCHE
# la reunión. Corré esto UNA vez en el droplet, como root o con sudo:
#
#   bash bot/instalar-host.sh
#
# Requisito: Ubuntu 22.04+ (el droplet más barato de DigitalOcean alcanza).
set -euo pipefail

echo "== 1/6  Paquetes del sistema =="
apt-get update -y
apt-get install -y curl git pulseaudio pulseaudio-utils

echo "== 2/6  Node.js 20 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 3/6  Dependencias del bot (Playwright) =="
# Corré este script DESDE la carpeta del repo ya clonado (git clone ...).
if [ ! -f "bot/joinbot.mjs" ]; then
  echo "Ejecutá esto desde la raíz del repo de Unify (donde está la carpeta bot/)." >&2
  exit 1
fi
npm --prefix bot install --no-audit --no-fund

echo "== 4/6  Navegador de Playwright =="
# Se instala con el MISMO playwright-core del bot, así la versión de la
# librería y la del navegador siempre coinciden.
"$(pwd)/bot/node_modules/.bin/playwright-core" install --with-deps chromium

echo "== 5/6  Google Chrome (las llaves del servicio de voz) =="
# El Chromium de Playwright NO trae las llaves de Google del reconocimiento
# de voz: el bot entra pero la transcripción muere con "network". El Google
# Chrome de verdad sí las trae, y el bot lo usa solo si está instalado.
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi
google-chrome-stable --version

echo "== 6/6  Audio virtual (para que el bot oiga la reunión) =="
# Un "parlante" virtual: lo que la reunión reproduce cae acá y el
# reconocimiento de voz lo puede tomar.
pulseaudio --start --exit-idle-time=-1 || true
pactl load-module module-null-sink sink_name=unify_sink sink_properties=device.description=UnifySink >/dev/null 2>&1 || true
pactl set-default-sink unify_sink >/dev/null 2>&1 || true

echo
echo "LISTO. El host quedó preparado."
echo
echo "Ahora, para probar (Jitsi primero, que no pide nada):"
echo '  node bot/lanzar.mjs "https://meet.jit.si/UnaSalaDePrueba"'
echo
echo "Para Google Meet necesitás el perfil con la sesión de Google del bot"
echo "(ver bot/README.md, sección 3). Pasás BOT_PROFILE_DIR=/ruta/al/perfil."
