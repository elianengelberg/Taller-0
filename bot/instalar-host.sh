#!/usr/bin/env bash
# Deja un droplet de Ubuntu (DigitalOcean) listo para correr el bot Notetaker:
# Node, el navegador de Playwright, y el audio virtual para que el bot ESCUCHE
# la reunión. Corré esto UNA vez en el droplet, como root o con sudo:
#
#   bash bot/instalar-host.sh
#
# Requisito: Ubuntu 22.04+ (el droplet más barato de DigitalOcean alcanza).
set -euo pipefail

echo "== 1/7  Paquetes del sistema =="
apt-get update -y
apt-get install -y curl git pulseaudio pulseaudio-utils

echo "== 2/7  Node.js 20 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 3/7  Dependencias del bot (Playwright) =="
# Corré este script DESDE la carpeta del repo ya clonado (git clone ...).
if [ ! -f "bot/joinbot.mjs" ]; then
  echo "Ejecutá esto desde la raíz del repo de Unify (donde está la carpeta bot/)." >&2
  exit 1
fi
npm --prefix bot install --no-audit --no-fund

echo "== 4/7  Navegador de Playwright =="
# Se instala con el MISMO playwright-core del bot, así la versión de la
# librería y la del navegador siempre coinciden.
"$(pwd)/bot/node_modules/.bin/playwright-core" install --with-deps chromium

echo "== 5/7  Google Chrome (las llaves del servicio de voz) =="
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

echo "== 6/7  Audio virtual (para que el bot oiga la reunión) =="
# Un "parlante" virtual: lo que la reunión reproduce cae acá y el
# reconocimiento de voz lo puede tomar.
pulseaudio --start --exit-idle-time=-1 || true
pactl load-module module-null-sink sink_name=unify_sink sink_properties=device.description=UnifySink >/dev/null 2>&1 || true
pactl set-default-sink unify_sink >/dev/null 2>&1 || true

echo "== 7/7  El agente de despachos (para el botón de la web) =="
# Render no puede abrir un navegador: cuando alguien toca "Que entre el bot
# por mí", el servidor le REENVÍA el pedido a este agente, que corre acá y
# lanza el bot. Queda como servicio de systemd: arranca solo al prender el
# droplet y revive si se cae. El secreto compartido se genera una sola vez.
if [ ! -f /etc/unify-bot.env ]; then
  SECRETO="$(openssl rand -hex 24)"
  {
    echo "BOT_HOST_SECRET=$SECRETO"
    echo "SERVER_URL=https://taller-0.onrender.com"
  } > /etc/unify-bot.env
  chmod 600 /etc/unify-bot.env
fi
REPO="$(pwd)"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/unify-bot-agent.service <<UNIT
[Unit]
Description=Agente del bot Notetaker de Unify
After=network-online.target

[Service]
EnvironmentFile=/etc/unify-bot.env
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/bot/agente.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now unify-bot-agent >/dev/null 2>&1 || true
systemctl restart unify-bot-agent
sleep 1
systemctl is-active unify-bot-agent || true

IP_PUBLICA="$(curl -s -4 --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "LISTO. El host quedó preparado."
echo
echo "Para que el botón «Que entre el bot por mí» de la web funcione, agregá"
echo "estas TRES variables en Render (Environment) y redeploy:"
echo "  BOT_ENABLED=1"
echo "  BOT_HOST_URL=http://$IP_PUBLICA:4790"
grep BOT_HOST_SECRET /etc/unify-bot.env | sed 's/^/  /'
echo
echo "Y para probar a mano (Jitsi primero, que no pide nada):"
echo '  node bot/lanzar.mjs "https://meet.jit.si/UnaSalaDePrueba"'
echo
echo "Para Google Meet necesitás el perfil con la sesión de Google del bot"
echo "(ver bot/README.md, sección 3). Pasás BOT_PROFILE_DIR=/ruta/al/perfil."
