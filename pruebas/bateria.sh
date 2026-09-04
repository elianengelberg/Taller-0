#!/bin/bash
# La batería COMPLETA de suites contra el stack real, en un solo comando.
#
#   bash pruebas/bateria.sh            # todo
#   bash pruebas/bateria.sh sim_av     # una sola (o varias, separadas por espacio)
#
# Deja un renglón por suite en /tmp/bateria-resultados.txt y el log de cada
# una en /tmp/bateria/<suite>.log. Levanta lo que falte (Postgres en :5433,
# el servidor en :4001, el estático en :4174) y lo vuelve a levantar después
# de las suites DISRUPTIVAS, que van al final a propósito: sim_basecaida
# apaga Postgres, sim_renacer mata al servidor y sim_carga mata TODO tsx
# ajeno y levanta el suyo (las dos últimas necesitan el 4001 libre).
# sim_video_ia también necesita el 4001 libre: corre aparte, al final.
#
# Requisitos: el build de producción ya hecho (cd client && VITE_SERVER_URL=
# http://localhost:4001 npm run build) y desktop/node_modules instalado
# (sim_escritorio usa Electron real).
set -u
cd "$(dirname "$0")/.."
OUT=/tmp/bateria-resultados.txt
mkdir -p /tmp/bateria
: > "$OUT"

PG=/usr/lib/postgresql/16/bin/pg_ctl
DB_URL="postgres://postgres@localhost:5433/unify"

matar_servidor() {
  for PID in $(ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}'); do
    kill "$PID" 2>/dev/null
  done
  sleep 1
}

levantar_servidor() {
  matar_servidor
  (cd server && DATABASE_URL="$DB_URL" \
    AUTH_SECRET="clave-de-pruebas-local-larga-1234567890" PORT=4001 \
    CLIENT_ORIGIN="http://localhost:4174" MAIL_LOG=1 \
    LIMITE_AUTH_POR_IP=30 LIMITE_TRADUCCIONES=240 LIMITE_CREDENCIALES=30 \
    LIMITE_SUBIDAS=20 LIMITE_CORREOS=20 LIMITE_BRIDGE=240 \
    npx tsx src/index.ts > /tmp/unify-server.log 2>&1 &)
  for _ in $(seq 1 40); do
    curl -s -m 1 http://localhost:4001/api/health > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "SERVIDOR NO LEVANTO" >&2
  return 1
}

asegurar_stack() {
  su postgres -c "$PG -D /tmp/pgdata -o '-p 5433' status" > /dev/null 2>&1 ||
    su postgres -c "$PG -D /tmp/pgdata -o '-p 5433' -l /tmp/pglog.txt start" > /dev/null 2>&1
  sleep 1
  curl -s -m 2 http://localhost:4001/api/health > /dev/null 2>&1 || levantar_servidor
  curl -s -m 2 http://localhost:4174/ > /dev/null 2>&1 ||
    (nohup node pruebas/serve_csp.js > /tmp/serve_csp.log 2>&1 &)
  sleep 1
}

correr() { # nombre comando...
  local n=$1; shift
  local log=/tmp/bateria/$n.log
  local t0=$(date +%s)
  timeout 1200 "$@" > "$log" 2>&1
  local code=$?
  local dur=$(( $(date +%s) - t0 ))
  local resumen
  resumen=$(grep -E "^[0-9]+/[0-9]+ OK$" "$log" | tail -1)
  local fails
  fails=$(grep -c "^FAIL" "$log")
  echo "$n | exit=$code | ${dur}s | FAIL=$fails | $resumen" >> "$OUT"
}

# Las de interfaz primero (fallan rápido si se rompió una pantalla), después
# las del servidor, y la cola disruptiva al final.
NORMALES="sim_fixes sim_botones sim_external_ui sim_errores sim_instalar sim_pwa sim_movil
  sim_perfil sim_verificacion sim_reconexion sim_malla sim_persona_zoom sim_av sim_companion
  sim_toast sim_realext sim_voces_reunion sim_puente_salas sim_codigo sim_traduccion
  sim_calendario sim_analiticas sim_bot sim_audit sim_bridge sim_cuentas sim_email
  sim_escritorio sim_estres sim_inputs sim_plataformas sim_seguridad"
DISRUPTIVAS="sim_basecaida sim_renacer sim_carga sim_video_ia"

if [ $# -gt 0 ]; then
  for s in "$@"; do asegurar_stack; correr "$s" xvfb-run -a node "pruebas/$s.js"; done
  echo "BATERIA-TERMINADA" >> "$OUT"
  exit 0
fi

for s in $NORMALES; do
  asegurar_stack
  correr "$s" xvfb-run -a node "pruebas/$s.js"
done
asegurar_stack
correr sim_agenda env DATABASE_URL="$DB_URL" server/node_modules/.bin/tsx pruebas/sim_agenda.ts

for s in $DISRUPTIVAS; do
  asegurar_stack
  case "$s" in sim_renacer|sim_carga|sim_video_ia) matar_servidor ;; esac
  correr "$s" xvfb-run -a node "pruebas/$s.js"
  asegurar_stack
done
echo "BATERIA-TERMINADA" >> "$OUT"
