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

**Edge instala desde la misma tienda:** con la ficha de Chrome publicada, la
gente de Microsoft Edge también instala con un clic (Edge pregunta una vez
"¿Permitir extensiones de otras tiendas?" y listo; `/instalar` ya lo explica).

## Bonus opcional: la tienda de Edge (gratis)

Si además querés ficha propia en Edge, el registro de desarrollador de
[Microsoft Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/overview)
es **gratuito** (no tiene los US$ 5 de Google) y se sube el MISMO
`unify-extension.zip` con los mismos textos de abajo. No es obligatorio: la
ficha de Chrome ya cubre a Edge.

## Textos de la ficha (copiar y pegar)

> **POR QUÉ ESTOS TEXTOS SON ASÍ.** La versión 4.1.1 fue RECHAZADA por
> "Yellow Argon: spam de palabras clave". Lo señalado fue textual el título
> `EN ZOOM, TEAMS, JITSI, WEBEX, WHEREBY Y GOTO`: una lista de marcas en
> mayúsculas se lee como relleno para posicionar, no como descripción. La
> regla que sigue este texto: describir QUÉ HACE la extensión; nombrar una
> plataforma sólo donde aporta información real (Google Meet, porque ahí hay
> una integración distinta), nunca como enumeración. Las plataformas
> soportadas se declaran donde corresponde: en los permisos de host y su
> justificación.

**Nombre:** Unify — asistente de reuniones

**Descripción corta** (la toma del manifest, máx. 132 caracteres):
> Subtítulos en vivo con traducción, transcripción y grabación de tus videollamadas, con un asistente de IA.

**Descripción larga:**
> Unify te acompaña durante tus videollamadas: pone subtítulos en vivo, los traduce a tu idioma, guarda la transcripción y, si se lo pedís, graba la reunión.
>
> Cómo funciona
>
> • Al entrar a una videollamada, Unify te ofrece activar los subtítulos y la grabación. Si no respondés, los subtítulos arrancan solos a los cinco segundos.
> • Los subtítulos se ven sobre la llamada, con el nombre de quien habla y la traducción debajo. Elegís el idioma: español, inglés, portugués, francés, alemán, italiano o chino.
> • La grabación la iniciás vos, desde el ícono de la barra o con Ctrl+Shift+U, y queda guardada en tu cuenta con la transcripción sincronizada palabra por palabra.
> • Un asistente de IA responde preguntas sobre lo que se dijo — y sobre lo que se vio, porque también mira el video grabado.
>
> En Google Meet, además, Unify lee los subtítulos que genera la propia reunión para transcribir a todos los participantes con su nombre, y permite asignarle un rol a cada persona.
>
> Todo queda en tu cuenta de unify-meet.com, privado y sólo tuyo. Sin analytics, sin rastreadores y sin venta de datos.

**Categoría:** Productividad · **Idioma:** Español

**Sitio web:** `https://www.unify-meet.com` ·
**URL de asistencia:** `https://www.unify-meet.com/soporte`

**Capturas (1280×800):** ya están listas en `extension/store/`:
`captura-1-toast.png` (el aviso al entrar a una reunión) y
`captura-2-overlay.png` (grabando, con subtítulos traducidos). Subí las dos.

## Prácticas de privacidad (lo que pregunta el formulario)

**URL de política de privacidad:** `https://unify-meet.com/privacidad`

> Nota: el ZIP que se publica NO pide los orígenes de desarrollo (localhost,
> vercel.app) — el empaquetador los quita solo. El manifest del repo los
> conserva para trabajar local.

**Descripción de la finalidad única:**
> Unify tiene una única finalidad: asistir al usuario en la reunión en la que
> está participando, transcribiéndola, traduciéndola y grabándola. Todas sus
> funciones sirven a eso: subtítulos en vivo con el nombre de quien habla,
> traducción de esos subtítulos al idioma del usuario, grabación de la
> pestaña de la reunión iniciada por el usuario, y un asistente de IA que
> responde preguntas sobre lo transcripto. La extensión sólo actúa en páginas
> de reuniones (Google Meet, Zoom, Microsoft Teams, Jitsi, Webex, Whereby y
> GoTo) y en el sitio del propio servicio (unify-meet.com), donde el usuario
> ve su historial. No recopila datos de navegación ni ejecuta nada en otros
> sitios.

> Nota: el paquete ya NO pide el permiso `scripting` (se pedía sin usarse; la
> versión 4.1.1 fue rechazada y esa era una causa segura). Si el formulario lo
> sigue mostrando, es del borrador viejo: subir el ZIP nuevo lo saca.

**Justificación de activeTab:**
> Complementa a tabCapture para grabar la reunión: cuando el usuario invoca
> la extensión (clic en el ícono de la barra o atajo Ctrl+Shift+U), activeTab
> habilita la captura de la pestaña activa de la reunión. Es un acceso
> puntual, otorgado por esa acción explícita del usuario, y no se usa para
> leer contenido ni navegación de otras pestañas.

**Justificación de tabCapture:**
> Es la función central de grabación: captura el audio y el video de la
> pestaña de la reunión (todas las voces y lo que se muestra) para guardar la
> reunión en el historial privado del usuario en unify-meet.com. Sólo arranca
> tras una invocación explícita del usuario (ícono de la barra o atajo de
> teclado) y mientras graba se muestra un indicador visible (insignia REC y
> aviso dentro de la página). La grabación se envía únicamente al servidor
> del propio servicio.

**Justificación de storage:**
> Guarda las preferencias del usuario (idioma de la traducción de los
> subtítulos, dirección del servidor) y su sesión de Unify, para no pedirle
> iniciar sesión en cada reunión. También registros mínimos internos (última
> verificación de versión). No se guarda historial de navegación ni datos de
> otros sitios.

**Justificación de offscreen:**
> Es un requisito técnico de Manifest V3: el service worker no puede usar
> MediaRecorder, así que la grabación de la pestaña corre en un documento
> offscreen mientras el usuario graba, y se cierra al terminar. No accede a
> ningún contenido adicional.

**Justificación del permiso de host:**
> meet.google.com: leer los subtítulos nativos de Meet para transcribir con
> el nombre de quien habla y mostrar el panel. Los dominios de plataformas de
> videollamada (zoom.us, teams.microsoft.com, teams.live.com, meet.jit.si,
> 8x8.vc, webex.com, whereby.com, gotomeet.me/goto.com/gotomeeting.com,
> call.element.io, join.skype.com, discord.com, bluejeans.com, chime.aws,
> app.slack.com, call.whatsapp.com, zoho.com/zohomeeting.com, dialpad.com,
> ringcentral.com, livestorm.co, gather.town): detectar que el usuario está
> entrando a una reunión y ofrecerle ahí mismo los subtítulos y la grabación.
> Un enlace de reunión puede llegarle al usuario por cualquier vía (chat,
> correo, calendario), así que la extensión reconoce las plataformas de
> videollamada más usadas; en cada una hace exactamente lo mismo y sólo eso.
> unify-meet.com: sincronizar con la extensión la sesión que el usuario inició
> en el sitio. taller-0.onrender.com: es el servidor propio del servicio,
> adonde viajan (por HTTPS) la transcripción y las grabaciones del usuario
> para su historial privado. No se accede a ningún otro host.

**Uso de datos (declaración):** la extensión envía contenido de la reunión
(subtítulos leídos, audio/video grabado por pedido del usuario) únicamente al
servidor de Unify, para mostrarlo al propio usuario en su historial. No se
venden datos, no se usan para publicidad, no se comparten con terceros ajenos
al funcionamiento (la IA procesa la transcripción vía Anthropic).

**Remote code:** No usa código remoto (todo el código va dentro del paquete).
