# Unify

Una app de videollamadas al estilo Zoom pensada para reuniones con **roles asignables en
vivo**, **transcripción con nombre de quien habla** y **traducción automática** del chat y
de los subtítulos, con **grabación**, **historial permanente** y una **IA que responde
preguntas sobre cada reunión**. Paleta de marca: naranja claro, negro y blanco.

## Funcionalidad

- **Roles de reunión**: el anfitrión define los roles antes de empezar (ej. "Ingeniero
  civil", "Logística") y puede asignarlos —o crear nuevos— a cada participante durante la
  reunión, desde el panel de Participantes.
- **Videollamada**: grilla de video en vivo (WebRTC punto a punto, sin servidor de medios)
  con controles de micrófono/cámara, nombre y rol de cada persona sobre su video.
- **Transcripción en vivo**: usa el reconocimiento de voz del navegador para ir anotando
  quién dijo qué, y **traduce automáticamente todo al idioma que cada persona configuró al
  unirse** (subtítulo flotante en vivo + panel de transcripción completo). Si hay
  `ANTHROPIC_API_KEY` configurada, cada línea pasa primero por Claude para corregir errores
  típicos del reconocimiento de voz (palabras confundidas por otras que suenan parecido)
  antes de mostrarse, guardarse o traducirse. La transcripción se genera y guarda todo el
  tiempo (mientras no estés silenciado), sin importar si tenés abiertos los subtítulos o el
  panel de transcripción — esos botones solo controlan qué ves en pantalla, no si se está
  captando lo que se habla, para que el historial y la IA siempre tengan todo disponible.
- **Chat en vivo**: mensajería lateral, colapsada por defecto (con contador de no leídos) y
  expandible para leer cómodo, con opción de traducir automáticamente cada mensaje al
  idioma del anfitrión.
- **Compartir pantalla**: cualquier participante puede compartir su pantalla; se ve en vivo
  para todo el mundo (vía WebRTC, sin pasar por el servidor), con la pantalla compartida en
  grande y el resto de los participantes en una fila más chica debajo, y un botón para
  agrandarla a pantalla completa.
- **Grabación**: botón para grabar la reunión (pantalla compartida + audio propio y de los
  demás, mezclados). Al terminar, se puede descargar al toque y —si está configurado el
  guardado permanente— queda subida al historial.
- **Historial** (`/historial`): lista de reuniones pasadas con su chat, transcripción y
  video grabado (reproducible y descargable desde ahí).
- **IA por reunión**: desde el detalle de cada reunión en el historial, se le puede
  preguntar a una IA cosas como "¿qué dijo Germán?", pedirle un informe completo de la
  reunión (temas, decisiones, pendientes) o estadísticas (quién participó más, cuántos
  mensajes hubo, duración). Responde **solo** en base a lo que se dijo en esa reunión
  (nunca inventa ni usa conocimiento externo) y usa números ya calculados por el servidor
  para que las cantidades sean exactas, no estimadas.
- **IA de todas las reuniones** (arriba de todo en `/historial`): a diferencia de la
  anterior, esta busca en **todo** el historial guardado, no en una reunión puntual —
  preguntas como "¿tuve una reunión el 17 de junio?" o "¿de qué hablamos en la última
  reunión?". El servidor le pasa un índice de todas las reuniones (fecha, participantes,
  cantidad de mensajes) más la transcripción completa de las más recientes que entren en el
  presupuesto de contexto; las más viejas siguen siendo encontrables por fecha/participantes
  aunque no tenga su contenido palabra por palabra disponible.

## Stack

- **Servidor** (`/server`): Node.js + Express + Socket.io. Mantiene el estado de cada
  reunión en memoria mientras está en curso (roles, participantes, chat, transcripción) y
  actúa como servidor de señalización WebRTC y de traducción (Claude o, sin API key, un
  proveedor gratuito de respaldo). Opcionalmente persiste todo en Postgres, sube
  grabaciones a Cloudflare R2 y responde preguntas con la API de Anthropic — ver "Guardado
  permanente" abajo.
- **Cliente** (`/client`): React + TypeScript + Vite + Tailwind CSS. WebRTC en malla
  (`simple-peer`) para audio/video, `SpeechRecognition` del navegador para la
  transcripción, `MediaRecorder` + Web Audio API para grabar.

## Cómo correrlo

```bash
npm run install:all   # instala dependencias de server/ y client/
npm run dev            # levanta server (puerto 4000) y client (puerto 5173) juntos
```

También podés correr cada parte por separado:

```bash
npm run dev:server   # http://localhost:4000
npm run dev:client   # http://localhost:5173
```

Variables de entorno opcionales:

- `server/.env` → `PORT` (default 4000), `CLIENT_ORIGIN` (default
  `http://localhost:5173`, usado para CORS). Ver también "Guardado permanente" abajo.
- `client/.env` → `VITE_SERVER_URL` (default `http://localhost:4000`).

Para probarlo con más de una persona en la misma máquina, abrí dos pestañas o navegadores
distintos en `http://localhost:5173`.

## Guardado permanente (opcional)

Sin configurar nada de esto, la app funciona igual para hacer videollamadas — sólo que la
grabación se puede descargar pero no queda guardada en el servidor, y no hay historial ni
IA. Para activar el guardado permanente hacen falta 3 cuentas gratis (variables en
`server/.env`, ver `server/.env.example`):

1. **Base de datos** — [Neon](https://neon.tech) (Postgres gratis). Creá un proyecto,
   copiá el "connection string" y pegalo en `DATABASE_URL`.
2. **Almacenamiento de videos** — [Cloudflare R2](https://dash.cloudflare.com) (10 GB
   gratis, sin costo de salida de datos). Creá un bucket, un API token con permisos de
   lectura/escritura, y habilitá el acceso público (subdominio `r2.dev` o un dominio
   propio). Completá `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME` y `R2_PUBLIC_URL`. El navegador sube el video *directo* al bucket (no
   pasa por el servidor), así que además hay que configurar una **CORS Policy** en el
   bucket (Settings → CORS Policy) que permita `PUT` y `GET` desde el dominio de tu
   frontend, por ejemplo:
   ```json
   [{ "AllowedOrigins": ["https://tu-dominio.vercel.app"], "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["*"] }]
   ```
3. **IA** — una API key de [Anthropic Console](https://console.anthropic.com) (tiene costo
   por uso, aunque para preguntas cortas es muy bajo). Completá `ANTHROPIC_API_KEY`. Esta
   misma key también activa la traducción rápida por Claude, la corrección de errores de
   reconocimiento de voz en la transcripción y la explicación en español simple de errores
   crípticos que puedan aparecer en la interfaz (ver secciones de arriba) — sin ella, la IA
   de preguntas queda desactivada, la traducción usa el proveedor gratuito más lento, la
   transcripción no se corrige, y los errores se muestran tal cual vienen del navegador. Por
   defecto la IA de preguntas usa `claude-opus-4-8` (se puede cambiar con `ANTHROPIC_MODEL`),
   la traducción usa `claude-haiku-4-5` (se puede cambiar con `ANTHROPIC_TRANSLATE_MODEL`),
   la corrección de transcripción también usa `claude-haiku-4-5` (se puede cambiar con
   `ANTHROPIC_TRANSCRIPT_MODEL`), y la explicación de errores usa `claude-haiku-4-5` (se
   puede cambiar con `ANTHROPIC_ERROR_MODEL`).

4. **Correo** — [Resend](https://resend.com) (3.000 correos gratis por mes). Verificá tu
   dominio en *Domains*, generá una API key y completá `RESEND_API_KEY` y `MAIL_FROM`
   (tiene que ser una dirección de ese dominio verificado). Esto habilita dos cosas que sin
   correo no pueden existir: **verificar el email** al crear una cuenta y **recuperar la
   contraseña** si te la olvidás. Sin la key, la app anda igual, pero `/api/auth/config`
   avisa que están apagadas y la interfaz esconde “¿Olvidaste tu contraseña?” en vez de
   ofrecer un enlace que nunca va a llegar. Para probarlo en tu máquina, `MAIL_LOG=1`
   imprime los correos —con sus enlaces— en la consola del servidor, sin enviar nada.

Cada una de las cuatro es independiente: podés activar solo la base de datos (para guardar
mensajes) sin activar R2 (grabaciones), la IA, ni el correo, por ejemplo.

### Cómo quedan las cuentas con la verificación activada

- Al registrarse sale un correo con un enlace que vence en 24 horas. La sesión se abre
  igual en ese dispositivo (quien se registra suele venir de una reunión de invitado que
  quiere guardar), pero para **volver a entrar** desde cualquier lado hay que confirmar.
- Las cuentas creadas **antes** de configurar el correo no quedan trabadas: sólo se le
  exige el enlace a las que se crearon con el envío ya andando. El aviso dentro de la app
  las invita a confirmar, sin obligarlas.
- Las cuentas de Google llegan verificadas: Google ya probó la dirección.
- “Olvidé mi contraseña” manda un enlace de un solo uso que vence en una hora. Usarlo
  **cierra todas las sesiones abiertas** de esa cuenta, así que también sirve para echar a
  alguien que se metió. Si la cuenta entra sólo con Google no se le crea una contraseña: el
  correo explica que el acceso es por el botón de Google (y que la contraseña de Google se
  recupera en Google).

## Instalar como app (PWA)

Unify es una **PWA instalable**: en Chrome/Edge de escritorio o Android aparece
"Instalar Unify" en la barra de direcciones, y queda como una app más, con su
ícono, sin la barra del navegador y **abriéndose sola** desde el ícono.

- **Escritorio y Android**: se instala directo desde el navegador. En Android,
  además, Unify aparece en el menú de **Compartir**: si te llega un enlace de
  Zoom o Meet por WhatsApp, Compartir → Unify lo abre ya detectado en
  `/externa`.
- **Empaquetado para tiendas**:
  - **Android (Google Play)** conviene con **Bubblewrap/TWA**: envuelve la PWA en
    una Trusted Web Activity que corre en el Chrome del teléfono (cámara,
    micrófono y voz-a-texto funcionan igual que en la web) y se actualiza sola
    con cada deploy del frontend. Necesita `assetlinks.json` en
    `/.well-known/` con la huella de la clave de firma.
  - **iOS (App Store)** va con **Capacitor** (WKWebView). Ojo con dos límites de
    iOS: no existe `getDisplayMedia` (no hay grabar-pantalla) y la Web Speech
    API no anda en WKWebView — la transcripción del propio micrófono se hace con
    el reconocimiento nativo (`SFSpeechRecognizer`) alimentando el mismo evento
    `transcript-line`. La v1 de iOS es companion + historial + unirse a
    reuniones en primer plano.

El service worker está pensado para no molestar: **nunca** cachea `/api` ni el
socket (servir historial viejo sería corromper datos), deja fuera del precache
los bundles pesados (SDK de Zoom ~5,6 MB) para que instalar no cueste 10 MB, y
**no se actualiza en medio de una reunión** — el aviso de "hay una versión
nueva" solo aparece fuera de la llamada, para no cambiar los chunks bajo los
pies de la videollamada en curso.

## Limitaciones a tener en cuenta

- **Transcripción por voz**: usa la Web Speech API, que hoy solo está disponible en
  navegadores basados en Chromium (Chrome, Edge). En Firefox/Safari el botón de subtítulos
  queda deshabilitado automáticamente.
- **Cámara/micrófono/pantalla en producción**: los navegadores solo permiten
  `getUserMedia`/`getDisplayMedia` en `localhost` o sobre HTTPS. Si despliegan esto en un
  dominio real, necesitan certificado TLS (Vercel y Render ya lo dan gratis).
- **Videollamada en malla**: cada participante se conecta directo con todos los demás
  (peer-to-peer), lo cual es ideal para grupos chicos (hasta 6-8 personas
  aproximadamente). Para reuniones más grandes convendría migrar a un SFU (ej. LiveKit,
  mediasoup).
- **Traducción de texto** (chat/subtítulos): si `ANTHROPIC_API_KEY` está configurada, usa
  Claude Haiku (rápido, pensado para no atrasar una conversación en vivo). Si no, usa como
  respaldo la API gratuita y sin clave de MyMemory (`server/src/translate.ts`), que es más
  lenta y tiene límites de uso diarios. Para otro proveedor (DeepL, Google Cloud
  Translation) alcanza con cambiar ese archivo.
- **Grabación**: usa `getDisplayMedia`, así que el usuario tiene que elegir manualmente qué
  compartir (recomendado: "esta pestaña", con la casilla de audio de la pestaña tildada,
  para capturar también el audio de los demás participantes). La **extensión** evita ese
  paso: con `Ctrl+Shift+U` (o el ícono) captura la pestaña sin selector y con el audio
  garantizado, tanto en Meet como en Zoom/Teams/Jitsi/Webex.
- **Sin guardado permanente configurado**: el estado de una reunión en curso vive en
  memoria del servidor; si se reinicia mientras hay reuniones activas, se pierden. Con
  `DATABASE_URL` configurado, el chat y la transcripción quedan guardados igual aunque el
  servidor se reinicie.

## Estructura

```
server/
  src/
    index.ts             servidor Express + Socket.io + endpoints REST
    socketHandlers.ts     eventos de sockets (crear/unir reunión, roles, chat, señalización)
    meetingStore.ts       estado en memoria de las reuniones en curso
    translate.ts          proveedor de traducción de texto (reemplazable)
    db.ts                 persistencia en Postgres (historial), opcional
    storage.ts             subida de grabaciones a Cloudflare R2, opcional
    ai.ts                  preguntas a la IA sobre una reunión (Anthropic), opcional
client/
  src/
    pages/                Home, HostSetup (creador de roles), JoinForm, Meeting,
                           History (historial), MeetingDetail (detalle + IA)
    components/           VideoGrid, ControlBar, ParticipantsPanel, ChatPanel,
                           TranscriptPanel, RoleBadge, LiveCaption, RecordingBanner…
    hooks/                 useLocalMedia, useWebRTC (malla), useSpeechRecognition,
                           useLineTranslations, useRecorder
    context/               MeetingContext (estado global + eventos de socket)
```
