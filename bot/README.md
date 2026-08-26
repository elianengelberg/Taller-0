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

## Estado por plataforma (honesto)

| Plataforma | Estado |
|---|---|
| **Jitsi** | Funciona: muchas salas no piden permiso, el bot entra directo. Es el camino más sólido. |
| **Google Meet** | Mejor esfuerzo: Meet suele exigir que **alguien admita** al bot, y los selectores de la página cambian seguido. Se afina contra Meet real. |
| **Zoom (cliente web)** | Mejor esfuerzo: el camino robusto de verdad es el **Zoom Meeting SDK** (requiere credenciales de app y revisión de Zoom). |
| **`test`** | Una reunión local simulada, para probar toda la cadena sin depender de Zoom ni del servicio de voz. Es lo que corre `pruebas/sim_bot.js`. |

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
