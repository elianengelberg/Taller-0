# Encuentro

Una app de videollamadas al estilo Zoom pensada para reuniones con **roles asignables en
vivo**, **transcripción con nombre de quien habla** y **traducción automática** del chat y
de los subtítulos. Paleta de marca: naranja claro, negro y blanco.

## Funcionalidad

- **Roles de reunión**: el anfitrión define los roles antes de empezar (ej. "Ingeniero
  civil", "Logística") y puede asignarlos —o crear nuevos— a cada participante durante la
  reunión, desde el panel de Participantes.
- **Videollamada**: grilla de video en vivo (WebRTC punto a punto, sin servidor de medios)
  con controles de micrófono/cámara, nombre y rol de cada persona sobre su video.
- **Transcripción en vivo**: usa el reconocimiento de voz del navegador para ir anotando
  quién dijo qué, con formato `Nombre (Rol): texto`, y permite traducir toda la
  transcripción a otro idioma con un selector.
- **Chat en vivo**: mensajería lateral, colapsada por defecto (con contador de no leídos) y
  expandible para leer cómodo, con opción de traducir automáticamente cada mensaje al
  idioma del anfitrión.
- **Subtítulos en vivo**: además del panel de transcripción completo, se muestra la última
  frase dicha como subtítulo flotante sobre el video.

## Stack

- **Servidor** (`/server`): Node.js + Express + Socket.io. Mantiene el estado de cada
  reunión en memoria (roles, participantes, chat, transcripción) y actúa como servidor de
  señalización WebRTC y de traducción (proxy a una API gratuita).
- **Cliente** (`/client`): React + TypeScript + Vite + Tailwind CSS. WebRTC en malla
  (`simple-peer`) para audio/video, `SpeechRecognition` del navegador para la
  transcripción.

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
  `http://localhost:5173`, usado para CORS).
- `client/.env` → `VITE_SERVER_URL` (default `http://localhost:4000`).

Para probarlo con más de una persona en la misma máquina, abrí dos pestañas o navegadores
distintos en `http://localhost:5173`.

## Limitaciones a tener en cuenta

- **Transcripción por voz**: usa la Web Speech API, que hoy solo está disponible en
  navegadores basados en Chromium (Chrome, Edge). En Firefox/Safari el botón de subtítulos
  queda deshabilitado automáticamente.
- **Cámara/micrófono en producción**: los navegadores solo permiten `getUserMedia` en
  `localhost` o sobre HTTPS. Si despliegan esto en un dominio real, necesitan certificado
  TLS.
- **Videollamada en malla**: cada participante se conecta directo con todos los demás
  (peer-to-peer), lo cual es ideal para grupos chicos (hasta 6-8 personas
  aproximadamente). Para reuniones más grandes convendría migrar a un SFU (ej. LiveKit,
  mediasoup).
- **Traducción**: usa la API gratuita y sin clave de MyMemory
  (`server/src/translate.ts`), que tiene límites de uso diarios. Para un uso más intensivo,
  se puede reemplazar por otro proveedor (DeepL, Google Cloud Translation) cambiando solo
  ese archivo.
- **Estado en memoria**: el servidor no usa base de datos; si se reinicia, se pierden las
  reuniones activas.

## Estructura

```
server/
  src/
    index.ts            servidor Express + Socket.io + endpoint de traducción
    socketHandlers.ts    eventos de sockets (crear/unir reunión, roles, chat, señalización)
    meetingStore.ts      estado en memoria de las reuniones
    translate.ts         proveedor de traducción (reemplazable)
client/
  src/
    pages/               Home, HostSetup (creador de roles), JoinForm, Meeting
    components/          VideoGrid, ControlBar, ParticipantsPanel, ChatPanel,
                          TranscriptPanel, RoleBadge, LiveCaption…
    hooks/                useLocalMedia, useWebRTC (malla), useSpeechRecognition
    context/              MeetingContext (estado global + eventos de socket)
```
