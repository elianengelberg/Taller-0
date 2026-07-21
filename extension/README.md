# Unify para Google Meet (extensión)

Conecta tu Google Meet con Unify: mientras estás en la llamada de Meet, la
extensión sincroniza en tiempo real lo que Meet expone (si estás en llamada,
tu micrófono/cámara, cantidad de participantes, si alguien presenta y —
cuando el panel de personas de Meet está abierto — la lista de nombres) con
la sala companion de Unify, donde ya corren los subtítulos, la traducción y
la IA.

## Instalación (modo desarrollador)

1. Abrí `chrome://extensions` (o `edge://extensions`).
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → seleccioná esta carpeta (`extension/`).
4. Entrá a tu reunión de Meet, y en Unify pegá el mismo link
   (Inicio → "Unirme a una externa"). La tarjeta de Meet muestra el estado
   en vivo que reporta la extensión.

El badge del ícono muestra **ON** (verde) cuando el puente está conectado.

## Botón "Grabar con Unify" dentro de Meet

Al entrar a una llamada de Meet, la extensión muestra un botón flotante
**⏺ Grabar con Unify** (abajo a la derecha). Un clic abre Unify con esa
reunión ya detectada: si ya usaste Unify antes (nombre recordado), entrás
directo a la sala companion con el aviso "Listo para grabar" — un solo tap
en **Grabar** y elegís la pestaña de Meet (con la casilla de audio tildada).

¿Por qué no graba directamente desde Meet? Los navegadores exigen que la
captura de pantalla/pestaña la inicie un gesto del usuario en la app o en
la UI de la extensión — ningún script inyectado puede arrancar una grabación
solo. Este flujo de un clic es la integración más directa que la plataforma
permite, y es honesta: siempre ves qué se está capturando.

El botón se puede ocultar con la ✕ (queda oculto en esa pestaña). Si tu
Unify corre en otro dominio, configurá `appBase` en el storage de la
extensión (por defecto `https://www.unify-meet.com`).

## Qué puede y qué no puede hacer (limitaciones reales)

Google Meet **no tiene API pública** para apps de terceros dentro de la
llamada, y bloquea embeberse en iframes. Lo único técnicamente posible es lo
que hace esta extensión: **observar el DOM de Meet** desde adentro y
sincronizarlo hacia afuera. Por eso:

- **Posible**: detectar entrada/salida de la llamada, cambio de reunión en la
  misma pestaña, tu mic/cámara, cantidad de participantes, presentación
  activa, nombres del roster (con el panel de personas de Meet abierto) y
  hablantes activos (best-effort).
- **No posible**: controlar Meet desde afuera (mutear a otros, expulsar,
  apagar cámaras ajenas). Ninguna extensión puede — Google no lo expone. La
  moderación estilo Zoom de Unify aplica a las reuniones nativas de Unify;
  sobre Meet, la capa de Unify aporta lo que Meet no tiene: subtítulos
  multilenguaje, traducción, transcripción compartida e IA.
- Los selectores del DOM de Meet pueden cambiar cuando Google actualiza su
  interfaz; la extensión degrada campo por campo (envía `null`) en vez de
  romperse, y loguea con prefijo `[unify-meet]` en la consola de la pestaña
  de Meet para diagnosticar.

## Seguridad

- Solo corre en `meet.google.com`.
- Solo envía datos al servidor de Unify; el servidor valida, recorta y
  limita (rate-limit) cada campo antes de retransmitirlo a la sala, y lo
  trata como información de display, nunca como autoridad.
- Reconexión automática con backoff exponencial (2s → 60s máx.) si el
  servidor no responde, y aviso de salida (`inCall: false`) al cerrar la
  pestaña o cambiar de reunión.
