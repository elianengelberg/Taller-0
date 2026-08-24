# Suites de verificación

Corren contra el stack REAL: Postgres local, el servidor de verdad, el build
de producción servido con las cabeceras reales de `vercel.json`, y Chromium
real (bajo `xvfb-run` cuando hace falta ventana). Sin mocks del backend.

## Preparar el entorno

```bash
# 1. Postgres en :5433 con la base "unify" (una vez por máquina)
initdb -D /tmp/pgdata && pg_ctl -D /tmp/pgdata -o "-p 5433" start && createdb -p 5433 unify

# 2. El build de producción apuntando al servidor de pruebas
cd client && VITE_SERVER_URL=http://localhost:4001 npm run build

# 3. El estático con las cabeceras reales (puerto 4174)
node pruebas/serve_csp.js &

# 4. El servidor (puerto 4001) -- NO para sim_video_ia, que levanta el suyo
cd server && DATABASE_URL="postgres://postgres@localhost:5433/unify" \
  AUTH_SECRET="clave-de-pruebas-local-larga-1234567890" PORT=4001 \
  CLIENT_ORIGIN="http://localhost:4174" MAIL_LOG=1 \
  npx tsx src/index.ts > /tmp/unify-server.log 2>&1 &
# (el log en /tmp/unify-server.log es la "bandeja de entrada" que leen
#  sim_email y sim_verificacion)
```

## Correr

```bash
node pruebas/sim_puente_salas.js        # bridge por clave de sala (server)
node pruebas/sim_codigo.js              # el código de 6 dígitos, atacado (server + MAIL_LOG)
node pruebas/sim_basecaida.js           # apaga Postgres de verdad: el servidor no debe morir
node pruebas/sim_botones.js             # botones y pantallas, tocados en navegador real
node pruebas/sim_pwa.js                 # PWA: manifest, SW, share, offline
xvfb-run -a node pruebas/sim_instalar.js  # centro de instalación + ZIP + Apple
xvfb-run -a node pruebas/sim_toast.js     # extensión real: toast/overlay/grabación
node pruebas/sim_video_ia.js            # IA multimodal + karaoke (4001 LIBRE)
node pruebas/sim_traduccion.js          # traducción: proveedor blindado, paridad de idiomas, voz propia
node pruebas/sim_av.js                  # DOS navegadores: mute/cámara/compartir CON audio + su transcripción
```

Criterios de la casa: probar el arreglo revirtiéndolo; desconfiar de los PASS
(un test que no puede probar lo que dice imprime SKIP, no PASS).
