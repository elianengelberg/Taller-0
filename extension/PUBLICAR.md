# Publicar la extensión en la Chrome Web Store

Todo lo de abajo está listo para copiar y pegar. El único trámite que no se
puede automatizar es tuyo: la cuenta de desarrollador y la revisión de Google.

## El paquete

El ZIP se genera solo en cada build de la web y queda en dos lados:

- **`https://unify-meet.com/unify-extension.zip`** — siempre la última versión.
- `client/dist/unify-extension.zip` después de `npm run build` en `client/`.

Ese MISMO archivo es el que se sube a la tienda. No hay que armar nada a mano.

## Pasos (una sola vez)

1. Entrá a la [Consola de desarrollador de Chrome Web Store](https://chrome.google.com/webstore/devconsole)
   con tu cuenta de Google y pagá el registro único (US$ 5).
2. **“Nuevo elemento”** → subí `unify-extension.zip`.
3. Completá la ficha con los textos de abajo.
4. En **Prácticas de privacidad**, marcá y justificá lo que se lista abajo
   (copiar/pegar) y poné la URL de privacidad: `https://unify-meet.com/privacidad`.
5. Enviá a revisión. Suele tardar de 1 a 3 días hábiles.
6. Cuando la aprueben, copiá la URL de la ficha
   (`https://chromewebstore.google.com/detail/…`) y pegala en
   `client/src/pages/Instalar.tsx` → `CHROME_WEB_STORE_URL`. Con eso, el botón
   de `/instalar` pasa solo de “Descargar el ZIP” a “Agregar a Chrome”.

Las actualizaciones futuras son: subir el ZIP nuevo (con `version` mayor en el
manifest) y listo — quienes la tengan instalada se actualizan solos.

## Textos de la ficha (copiar y pegar)

**Nombre:** Unify — asistente de reuniones

**Descripción corta** (máx. 132 caracteres):
> Subtítulos traducidos, transcripción y grabación en tus reuniones de Meet, Zoom, Teams y Jitsi — con IA sobre lo que se habló.

**Descripción larga:**
> Unify te acompaña en cualquier reunión, sin cambiar de plataforma.
>
> DENTRO DE GOOGLE MEET
> • Transcribe a TODOS los participantes (lee los subtítulos nativos de Meet, con el nombre de quien habla).
> • Subtítulos traducidos en vivo: chino, inglés, alemán, francés, portugués, italiano y español.
> • Graba la reunión completa (todas las voces) con un atajo: Ctrl+Shift+U.
> • Roles por participante y un asistente de IA que responde sobre lo que se dijo.
>
> EN ZOOM, TEAMS, JITSI, WEBEX, WHEREBY Y GOTO
> • Detecta que estás entrando a una reunión y te lo ofrece ahí mismo: “Veo que te estás uniendo a una reunión. ¿Querés los subtítulos y grabar?”
> • Si no respondés, a los 5 segundos arranca solo con los subtítulos.
> • Overlay flotante con la transcripción en vivo, la foto de cada hablante, la traducción automática en tu idioma y la IA para preguntar ahí mismo.
> • La grabación queda en tu historial de Unify, con la transcripción sincronizada palabra por palabra y una IA que además MIRA el video grabado.
>
> Todo queda guardado en tu cuenta de Unify (unify-meet.com), privado y solo tuyo. Sin analytics, sin trackers, sin venta de datos.

**Categoría:** Productividad · **Idioma:** Español

**Capturas (1280×800):** ya están listas en `extension/store/`:
`captura-1-toast.png` (el aviso al entrar a una reunión) y
`captura-2-overlay.png` (grabando, con subtítulos traducidos). Subí las dos.

## Prácticas de privacidad (lo que pregunta el formulario)

**URL de política de privacidad:** `https://unify-meet.com/privacidad`

**Justificación de cada permiso:**

- `activeTab` — Capturar la pestaña de la reunión para grabarla cuando el
  usuario lo pide desde el ícono o el atajo de teclado.
- `tabCapture` — Grabar el audio y el video de la pestaña de la reunión
  (todas las voces), siempre iniciado por una acción del usuario.
- `scripting` / content scripts — Mostrar el panel de subtítulos y el aviso de
  grabación dentro de las páginas de reuniones (Meet, Zoom, Teams, Jitsi,
  Webex, Whereby, GoTo). No corre en ningún otro sitio.
- `storage` — Guardar las preferencias del usuario (idioma de los subtítulos,
  servidor) y su sesión de Unify.
- `offscreen` — En Manifest V3 el service worker no puede usar MediaRecorder:
  la grabación corre en un documento offscreen.
- Permisos de host (`meet.google.com`, `zoom.us`, `teams.microsoft.com`,
  `teams.live.com`, `meet.jit.si`, `8x8.vc`, `webex.com`, `unify-meet.com`,
  servidor de Unify) — Son las páginas de reuniones donde trabaja la extensión
  y el servidor propio al que sube transcripción y grabaciones.

**Uso de datos (declaración):** la extensión envía contenido de la reunión
(subtítulos leídos, audio/video grabado por pedido del usuario) únicamente al
servidor de Unify, para mostrarlo al propio usuario en su historial. No se
venden datos, no se usan para publicidad, no se comparten con terceros ajenos
al funcionamiento (la IA procesa la transcripción vía Anthropic).

**Remote code:** No usa código remoto (todo el código va dentro del paquete).
