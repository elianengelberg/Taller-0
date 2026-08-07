# Unify para Google Meet

Extensión de Chrome/Edge que mete Unify **dentro** de Google Meet: transcribe a
todos los participantes, traduce en vivo, graba la reunión completa y responde
con IA — sin salir de la pestaña de Meet y sin pantallas divididas.

## Qué hace

| Función | Cómo funciona |
|---|---|
| **Transcribe a TODOS** | Lee los subtítulos propios de Google Meet, que ya traen a cada participante con su nombre. |
| **Subtítulos traducidos** | Muestra lo que se dice sobre el video, traducido al idioma que elijas. |
| **Graba la reunión completa** | Captura el audio y el video de la pestaña de Meet (todas las voces) y le suma tu micrófono. |
| **Roles por participante** | Etiquetá a cada persona (Anfitrión, Cliente, Equipo, Invitado): el rol aparece en los subtítulos y en la transcripción. |
| **Asistente de IA** | Preguntas sobre lo que se dijo, respondidas desde la transcripción de esa reunión. |
| **Historial** | Todo queda guardado en tu cuenta de Unify: transcripción, grabación e informe. |

## Por qué lee los subtítulos de Meet

Un navegador solo puede escuchar **tu** micrófono. Por eso cualquier herramienta
que transcriba "desde afuera" captura una sola voz: la tuya. Google Meet, en
cambio, ya transcribe a todos con sus propios subtítulos y les pone el nombre de
quien habla. Leer esos subtítulos es la única forma de tener la reunión completa.

**Por eso la extensión necesita que los subtítulos de Meet estén activos.** Si
están apagados, los prende sola la primera vez; si no puede, el panel te lo pide.

## Instalar (modo desarrollador)

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → elegí esta carpeta (`extension/`).
4. Entrá a una reunión de Google Meet: el panel de Unify aparece abajo a la derecha.

Para que funcione la IA, iniciá sesión una vez en la web de Unify en ese mismo
navegador. La extensión toma esa sesión sola — no hay que copiar ni pegar nada.

## Cómo se usa

- El panel se **arrastra** desde su encabezado y se **minimiza** con `—`.
- **Transcripción**: todo lo que se va diciendo, con el nombre de cada persona.
- **Subtítulos**: elegí el idioma de traducción y si querés verlos sobre el video.
- **IA**: preguntale lo que quieras sobre la reunión en curso.
- **Roles**: asigná una etiqueta a cada participante; se ve en los subtítulos.
- **Grabar**: hay tres caminos, y todos graban a todos los participantes:
  1. **Atajo `Ctrl+Shift+U`** (`⌘⇧U` en Mac) — el más rápido.
  2. **Ícono de Unify en la barra** → *Grabar la reunión*.
  3. El botón **⏺** del panel. Si Chrome pide una acción desde la barra
     (es un requisito suyo para capturar la pestaña), el panel te muestra el
     atajo en el momento.

  Volvé a hacer lo mismo para detener; el video se sube solo a tu historial.

## Permisos y por qué

| Permiso | Para qué |
|---|---|
| `storage` | Guardar tus preferencias (idioma, posición del panel) y la sesión de Unify. |
| `tabCapture` | Grabar el audio y el video de la reunión de Meet. |
| `activeTab` / `scripting` | Habilitar la captura de la pestaña cuando la invocás desde la barra o el atajo. |
| `offscreen` | Manifest V3 no deja grabar desde el service worker; la grabación corre en un documento invisible. |
| Acceso a `meet.google.com` | Mostrar el panel y leer los subtítulos de la reunión. |
| Acceso al servidor de Unify | Enviar la transcripción y subir la grabación. |
| Acceso a la web de Unify | Tomar tu sesión iniciada para habilitar la IA. |

La extensión **no** lee tu correo, tu historial ni ninguna otra pestaña.

## Ajustes

Clic en el ícono de Unify en la barra del navegador: ahí se ve el estado de la
sesión y se puede cambiar el servidor (útil para desarrollo local, por ejemplo
`http://localhost:4001`).

## Limitaciones honestas

- **Necesita los subtítulos de Meet activos.** Es la fuente de las voces de todos.
- **Depende del idioma de los subtítulos de Meet**: si Meet está transcribiendo
  en inglés y se habla español, los subtítulos van a salir mal. Se cambia desde
  el propio Meet.
- **Google cambia el HTML de Meet sin avisar.** Cada lectura degrada a "no
  disponible" en vez de romper el panel, pero un cambio grande puede requerir
  una actualización de la extensión.
- **La grabación necesita que la pestaña de Meet siga abierta.** Si la cerrás,
  la grabación se cierra y se sube lo grabado hasta ese momento.
- **Chrome exige que la orden de grabar venga de la barra del navegador** (el
  atajo o el ícono), no de un botón dentro de la página. Es una regla de Chrome
  para que ninguna web pueda grabarte sola; por eso existen los tres caminos.
