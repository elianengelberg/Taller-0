#!/bin/bash
# SABOTAJE: la prueba de las pruebas. Rompe a propósito una función y exige
# que la suite que la cubre FALLE. Si una suite sigue en verde con la función
# rota, esa suite no prueba lo que dice -- y eso es lo que se quiere saber.
#
#   bash pruebas/sabotaje.sh            # todos los sabotajes
#   bash pruebas/sabotaje.sh anti-eco   # uno solo
#
# Cada sabotaje: copia de respaldo del archivo, cambio quirúrgico con sed,
# reinicio del servidor si hace falta, la suite, y la restauración (también
# si algo revienta en el medio: trap). Imprime DETECTA / NO DETECTA.
set -u
cd "$(dirname "$0")/.."
DB_URL="postgres://postgres@localhost:5433/unify"

levantar_servidor() {
  for PID in $(ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}'); do kill "$PID" 2>/dev/null; done
  sleep 1
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
  echo "SERVIDOR NO LEVANTO" >&2; return 1
}

# nombre | archivo | expresión sed | suite | texto del check que TIENE que fallar | reinicia servidor
SABOTAJES=(
  "anti-eco|server/src/eco.ts|s/const desde = Date.now() - VENTANA_ECO_MS;/return null; const desde = Date.now() - VENTANA_ECO_MS;/|sim_bridge|se responde como eco|si"
  "provisional|server/src/index.ts|s/const provisional = anthropicEnabled;/const provisional = false;/|sim_traduccion|sale AL INSTANTE|no"
  "historial-fusion|server/src/index.ts|s/if (memoria.dbMessageId != null) void updateMessageText(memoria.dbMessageId, mergeTarget.text);/\\/\\/ sabotaje/|sim_bridge|guardan el texto COMPLETO|si"
  "zip-symlink|desktop/extensionLocal.js|s/await revisarZip(zipTmp);/\\/\\/ sabotaje/|sim_escritorio|enlace simbólico se rechaza|no"
  "cors-puente|desktop/puente.js|s/if (!origenPermitido(origen)) {/if (false) {/|sim_escritorio|página ajena recibe 403|no"
)

total=0; detectados=0
for linea in "${SABOTAJES[@]}"; do
  IFS='|' read -r nombre archivo expr suite texto reinicia <<< "$linea"
  if [ $# -gt 0 ] && [ "$1" != "$nombre" ]; then continue; fi
  total=$((total + 1))
  cp "$archivo" "$archivo.sabotaje.bak"
  restaurar() { mv -f "$archivo.sabotaje.bak" "$archivo" 2>/dev/null; }
  trap restaurar EXIT
  sed -i "$expr" "$archivo"
  if cmp -s "$archivo" "$archivo.sabotaje.bak"; then
    echo "?? $nombre: el sed no cambió nada ($archivo) -- revisar la expresión"
    restaurar; trap - EXIT; continue
  fi
  [ "$reinicia" = "si" ] && levantar_servidor > /dev/null
  log=/tmp/sabotaje-$nombre.log
  xvfb-run -a node "pruebas/$suite.js" > "$log" 2>&1
  code=$?
  restaurar; trap - EXIT
  [ "$reinicia" = "si" ] && levantar_servidor > /dev/null
  if [ $code -ne 0 ] && grep -q "^FAIL.*$texto" "$log"; then
    echo "DETECTA    $nombre -> $suite falla como debe: $(grep -m1 "^FAIL.*$texto" "$log" | cut -c1-110)"
    detectados=$((detectados + 1))
  elif [ $code -ne 0 ]; then
    echo "PARCIAL    $nombre -> $suite falla, pero no en «$texto» (ver $log)"
  else
    echo "NO DETECTA $nombre -> $suite quedó en VERDE con la función rota (ver $log)"
  fi
done
echo "sabotajes detectados: $detectados/$total"
[ "$detectados" -eq "$total" ]
