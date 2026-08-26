# El bot de reunión de Unify ("Notetaker")

Un participante-bot que **entra a una reunión, la escucha, la transcribe y sale
solo** — el equivalente al "Read AI Notetaker", pero apoyado en toda la
infraestructura que Unify ya tiene.

## Cómo está pensado

El bot es deliberadamente **delgado**: no reimplementa nada. Se une a la
reunión, saca texto del audio y lo **POSTea al mismo bridge** que usan la
extensión y la web (`/api/meet-bridge/:clave/transcript`). El bridge se
encarga de todo lo demás, que ya estaba hecho y probado:

- corrección de la frase con IA (palabras mal oídas),
- traducción a los 8 idiomas,
- guardado en el historial (con su resumen automático al terminar),
- transmisión **en vivo** a la sala companion (quien abre "Unify al lado" ve
  al bot hablar en tiempo real),
- las analíticas de participación salen gratis del transcripto.

O sea: el bot es "un par de oídos con patas". Toda la inteligencia es la de
siempre.

## Correrlo

La forma corta (deriva plataforma y clave de sala sola, con las mismas reglas
que la web, y apunta al servidor de producción):

```bash
node bot/lanzar.mjs "https://meet.jit.si/MiSala"
```

La forma larga, con todo explícito (lo que usa `lanzar.mjs` por debajo):

```bash
MEETING_URL="https://meet.jit.si/MiSala" \
ROOM_KEY="jitsi:meet.jit.si/misala" \
SERVER_URL="https://taller-0.onrender.com" \
BOT_NAME="Unify Notetaker" \
PLATFORM=jitsi \
node bot/joinbot.mjs
```

O por el servidor (lo que usa la web): `POST /api/bot/dispatch` con
`{ url, roomKey, platform }` (requiere sesión y `BOT_ENABLED=1`). La detección
`URL → plataforma + clave` la hace el cliente con `detectMeetingPlatform`, así
que el bot y la gente caen en **la misma sala**.

## El bot entra silenciado y sin cámara

Un notetaker no habla ni se muestra: en la pantalla previa apaga micrófono y
cámara antes de entrar, descarta los diálogos de permiso ("Got it",
"Continuar sin micrófono"), y espera a ser admitido si la reunión tiene sala
de espera. Sale solo cuando la reunión termina, cuando lo echan, o cuando la
barra de la llamada desaparece ~15 s (la sala se vació).

Variables extra:
- `BOT_PROFILE_DIR`   carpeta de un perfil de Chrome persistente (clave para
                      Google Meet: iniciás sesión de Google ahí UNA vez y el
                      bot reusa esa cuenta). Ver el paso a paso de abajo.
- `ADMISION_MS`       cuánto esperar a que te admitan (default 120000 = 2 min).

## Estado por plataforma (honesto)

| Plataforma | Estado |
|---|---|
| **Jitsi** | Funciona: muchas salas no piden permiso, el bot entra directo. Es el camino más sólido para empezar. |
| **Google Meet** | Afinado: apaga cam/mic, pide unirse y espera admisión. Meet casi siempre exige que **alguien admita** al bot y que la cuenta esté **iniciada** — por eso el perfil persistente. Los selectores de Meet cambian seguido; se ajustan contra Meet vivo. |
| **Zoom (cliente web)** | Afinado para salas sin restricción: "unirse desde el navegador", nombre, unir audio por computadora. El camino robusto de verdad es el **Zoom Meeting SDK** (credenciales de app + revisión de Zoom). |
| **`test`** | Una reunión local simulada, para probar toda la cadena sin Zoom ni el servicio de voz. Es lo que corre `pruebas/sim_bot.js`. |

## Paso a paso para ponerlo en producción (lo que hacés VOS)

Esto es lo que este entorno no puede hacer por sí solo (no llega a Zoom/Meet
reales) y queda de tu lado. En orden:

### 1. Un host que permita navegador headless
El web service de Render de siempre NO sirve para esto (no trae navegador ni
audio). Necesitás una máquina con Linux donde el bot pueda abrir Chromium:
- Un **Render Background Worker**, un droplet de DigitalOcean, una VM de
  Google Cloud/AWS, o incluso una compu de la oficina prendida.
- En esa máquina: `node` 20+, y `npx playwright install chromium` una vez.
- Para que el bot ESCUCHE el audio de la reunión hace falta un audio virtual:
  en Linux, `sudo apt-get install -y pulseaudio` y correr el bot con un sink
  virtual (`pulseaudio --start`). Sin eso, el bot entra pero no oye.

### 2. Encender el bot en el servidor
En las variables de entorno del servidor de Unify (Render):
- `BOT_ENABLED=1`
- (opcional) `BOT_NAME=Unify Notetaker` — cómo aparece en la lista de participantes.

### 3. Preparar la cuenta de Google del bot (para Meet)
Meet rebota a los invitados anónimos, así que el bot necesita una cuenta:
1. Creá una cuenta de Google para el bot (ej. `notetaker@tuempresa.com`).
2. En el host del bot, una sola vez, abrí Chromium con el perfil que va a usar
   y logueá esa cuenta a mano:
   `npx playwright open --browser chromium --user-data-dir=/ruta/al/perfil https://accounts.google.com`
   Iniciá sesión y cerrá la ventana.
3. Corré el bot con `BOT_PROFILE_DIR=/ruta/al/perfil`. Ahora entra a Meet como
   esa cuenta (alguien de la reunión igual tiene que **admitirlo** la primera
   vez, salvo que sea de tu organización).

### 4. Zoom (si lo vas a usar en serio)
Para salas sin contraseña, el cliente web ya alcanza. Para producción formal:
1. Creá una app en el **Zoom App Marketplace** (tipo "Meeting SDK").
2. Guardá su Client ID / Secret como variables del servidor.
3. (Esto es una fase aparte: el join por SDK es más robusto que el navegador,
   pero pide la revisión de Zoom. Avisame cuando tengas las credenciales y lo
   cableo.)

### 5. Probar, en este orden
1. **Jitsi primero** (no necesita nada): creá una sala en `meet.jit.si`,
   despachá el bot con `PLATFORM=jitsi`. Tiene que aparecer como participante
   y las líneas caer en el historial.
2. **Meet** con el perfil de Google listo: entrá vos a una reunión, despachá
   el bot, admitilo cuando pida entrar.
3. **Zoom** en una sala sin contraseña.

Si algo no entra, corré el bot con `stdio` visible y mandame lo que imprime:
los selectores de Meet/Zoom se ajustan mirando qué botón no encontró.

## Lo que este entorno NO puede probar (y por qué)

- **Unirse a Zoom/Meet reales**: requiere afinar selectores contra la
  plataforma viva y, en Zoom, el SDK oficial con credenciales. Este entorno
  no tiene salida a esas plataformas.
- **El servicio de voz** (Web Speech de Google): necesita salida a internet
  que este entorno no da. Por eso la prueba inyecta las líneas "habladas"
  tal como las daría el reconocimiento — el pipeline posterior es idéntico.

Lo que **sí** está probado de punta a punta (`sim_bot.js`, 15/15): el bot
entra, transcribe al bridge, aparece como participante que habla, se guarda en
el historial, sale limpio, y el **endpoint del servidor lo lanza** de verdad
con `BOT_ENABLED=1`.

## Producción

Unir un navegador headless a reuniones reales necesita un **host que lo
permita** (no el web dyno de Render de siempre) y algo de audio virtual para
capturar el sonido de la pestaña. La forma sana es un **worker aparte** que
reciba los despachos. Por eso el endpoint está detrás de `BOT_ENABLED=1`: se
enciende a propósito, en el host adecuado.
