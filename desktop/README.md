# Unify para escritorio (Windows)

La app que completa el flujo "me mandaron un Zoom y me uní desde la app":

1. Se instala como un programa normal (ícono en el escritorio y el menú
   Inicio, se puede ejecutar como administrador) y queda **en la bandeja**,
   al lado del reloj. Arranca sola con Windows.
2. Cuando la **app de Zoom** entra a una reunión (la señal es el proceso
   `CptHost.exe`, que Zoom levanta sólo dentro de una reunión), aparece
   **nuestro cartel** al medio: *"Uy, veo que te estás uniendo a una reunión.
   ¿Querés grabarla?"*. Si no se toca nada en 8 segundos, cuenta como **sí**.
3. Con el sí, se abre la **barra acompañante** (la web de Unify en una
   ventanita de Chrome abajo a la derecha): subtítulos en vivo, traducción,
   IA y grabación de pantalla+audio de la reunión.
4. Cuando Zoom cierra la reunión, la app lo detecta y se lo avisa a la barra
   por un puente local (`http://127.0.0.1:47125/estado`). La barra corta la
   grabación, la sube y **abre el detalle en el historial** (video +
   transcripción que se resalta mientras corre + IA para preguntar).

## Compilar el instalador (en Windows)

```
cd desktop
npm install
npm run dist
```

Sale en `desktop/dist/Unify-Setup.exe`. Ese archivo se sube a
**GitHub Releases** del repo (crear un release y adjuntarlo con ese nombre
exacto): el botón "Windows" de la página de instalar apunta a
`https://github.com/elianengelberg/Taller-0/releases/latest/download/Unify-Setup.exe`,
así siempre baja el último sin tocar la web.

> El instalador NSIS se compila en Windows. (Desde Linux/macOS también suele
> funcionar con `electron-builder`, pero probalo en Windows antes de publicar.)

## Microsoft Store (la vía sin avisos)

La tienda revisa el paquete y lo **firma con su propio certificado**: la
instalación desde la Store no pasa por SmartScreen ni por el "editor
desconocido", y las actualizaciones las trae la tienda. No hace falta comprar
certificado ni token. Es lo que corresponde para una persona sola (SignPath
Foundation pide visibilidad pública que el proyecto todavía no tiene y Azure
Trusted Signing no se ofrece en Argentina).

El workflow `instalador-windows.yml` arma el paquete en cada corrida
(`Unify-Store.appx`, target `appx` de electron-builder, **sin firmar**: así lo
pide la tienda) y lo deja como artefacto del run. La copia de la tienda se
comporta distinto en tres cosas, todas en `tienda.js`: no usa
electron-updater (la tienda actualiza), arranca con Windows por la
StartupTask de `build/appx-extensiones.xml` (no por el registro, que dentro
del paquete está virtualizado) y decide "abrir oculta" por la edad de la
sesión (la tarea de inicio no puede pasar `--oculto`). Los íconos de la
tienda salen de `build/appx/` (generados del ícono de la web).

Paso a paso, una sola vez:

1. **Cuenta de desarrollador**: https://partner.microsoft.com/dashboard →
   registrarse como *Individual* (cuota única de ~US$19; pide identidad y
   una tarjeta). Aparece "Apps and games".
2. **Reservar el nombre**: Apps and games → *New product* → *MSIX or PWA
   app* → nombre `Unify` (si está tomado, `Unify Meet`).
3. **Identidad del producto**: dentro del producto, *Product management →
   Product identity*. Copiar los tres valores y cargarlos en GitHub →
   Settings → Secrets → Actions:

   | Partner Center | Secreto |
   | --- | --- |
   | `Package/Identity/Name` (p. ej. `12345Elian.Unify`) | `MSSTORE_IDENTITY_NAME` |
   | `Package/Identity/Publisher` (`CN=XXXXXXXX-XXXX-...`) | `MSSTORE_PUBLISHER_ID` |
   | `Package/Properties/PublisherDisplayName` | `MSSTORE_PUBLISHER_DISPLAY_NAME` |

4. **Armar el paquete**: Actions → *Instalador de Windows* → *Run workflow*.
   Al terminar, bajar el artefacto `paquete-microsoft-store` (si dice
   `-SIN-identidad-de-tienda`, faltan los secretos: ese paquete NO sirve
   para la tienda).
5. **Enviar**: en el producto → *Start your submission*.
   - *Packages*: subir `Unify-Store.appx`. La tienda avisa que usa
     `runFullTrust`: es normal para una app de escritorio (Electron); si
     pregunta por qué, la respuesta es que detecta reuniones mirando los
     procesos y graba la pantalla a pedido de la persona.
   - *Properties*: categoría *Productivity*; *Age ratings*: contestar el
     cuestionario (sin contenido sensible).
   - *Store listing* (español, y opcional inglés): descripción, 2 o 3
     capturas (1366×768 o mayores), política de privacidad
     `https://www.unify-meet.com/privacidad`, sitio `https://www.unify-meet.com`.
   - *Pricing and availability*: gratis, todos los mercados.
   - *Submit*. La certificación tarda de horas a 3 días; los reparos llegan
     por email con el motivo exacto.
6. **Cuando esté publicada**: en la ficha figura la *Store ID* (algo como
   `9NBLGGH4R315`). Cargarla como `MSSTORE_PRODUCT_ID` (la app abre su
   ficha desde el menú) y poner en Vercel la variable
   `VITE_MSSTORE_URL=https://apps.microsoft.com/detail/<StoreID>` para que
   /instalar muestre el botón «Instalar desde la Microsoft Store».
7. **Versiones nuevas**: subir `version` en `package.json`, correr el
   workflow, subir el `.appx` nuevo en una submission nueva (la tienda
   exige que la versión sea mayor que la publicada). El instalador `.exe`
   sigue existiendo para quien tenga la tienda bloqueada.

## Firma del instalador (que Windows no avise)

Un `.exe` **sin firma digital** siempre dispara el aviso azul de SmartScreen
("aplicación no reconocida") y, a veces, un falso positivo de Defender: la app
graba la pantalla, mira el registro para detectar reuniones y arranca con
Windows, que es justo lo que las heurísticas miran con desconfianza. La única
solución de raíz es **firmar**. El workflow `instalador-windows.yml` firma
solo, apenas existan los secretos de alguna de estas vías:

| Vía | Costo | Qué hay que cargar en GitHub → Settings → Secrets |
| --- | --- | --- |
| **Azure Trusted Signing** (recomendada) | ~US$10/mes | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_PUBLISHER_NAME` |
| SignPath Foundation (código abierto) | gratis, requiere aprobación | `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` |
| Certificado propio exportable (.pfx) | según el emisor | `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD` |

### Azure Trusted Signing, paso a paso

1. Cuenta de Azure (portal.azure.com) con un método de pago.
2. Crear un recurso **Trusted Signing account** (región East US o West Europe;
   el *endpoint* queda como `https://eus.codesigning.azure.net` o
   `https://weu.codesigning.azure.net`).
3. En el recurso → **Identity validation** → **New identity** → *Individual*
   (o *Organization* si hay empresa registrada). Microsoft verifica identidad
   con documento; tarda de horas a pocos días.
4. Con la identidad aprobada → **Certificate profiles** → *Create* → tipo
   **Public Trust**, elegí la identidad. El nombre del perfil es
   `AZURE_SIGNING_PROFILE`; el nombre de la cuenta, `AZURE_SIGNING_ACCOUNT`.
   El *Subject* del perfil (empieza con `CN=`) es `AZURE_PUBLISHER_NAME`.
5. Microsoft Entra → **App registrations** → *New registration* ("unify-firma").
   Copiá `Application (client) ID` (`AZURE_CLIENT_ID`) y `Directory (tenant) ID`
   (`AZURE_TENANT_ID`). En *Certificates & secrets* creá un secreto
   (`AZURE_CLIENT_SECRET`).
6. Volvé al recurso Trusted Signing → **Access control (IAM)** → *Add role
   assignment* → rol **Trusted Signing Certificate Profile Signer** → a la app
   "unify-firma".
7. Cargá los siete secretos en GitHub y corré el workflow ("Instalador de
   Windows" → *Run workflow*). El `.exe` sale firmado; SmartScreen deja de
   avisar de inmediato (los certificados de Trusted Signing nacen con
   reputación).

### Mientras no haya firma

- SmartScreen: **Más información → Ejecutar de todas formas**.
- Defender lo puso en cuarentena: **Seguridad de Windows → Protección
  antivirus → Historial de protección → (el aviso) → Acciones → Permitir**, y
  volver a abrir el instalador.
- Reportar el falso positivo a Microsoft acelera que deje de pasar:
  https://www.microsoft.com/wdsi/filesubmission (como desarrollador de
  software).

## Probar sin Zoom (cualquier sistema)

- `npm start` abre la app en la bandeja.
- Menú de la bandeja → **"Probar el cartel"** muestra el cartel a mano.
- En Linux/macOS no hay Zoom que vigilar: la reunión se simula creando y
  borrando el archivo `unify-reunion-simulada` en el directorio temporal
  (`/tmp` en Linux). Crearlo = "entró a la reunión"; borrarlo = "terminó".
- `UNIFY_WEB=http://localhost:4174 npm start` apunta la barra al build local.

## Piezas

| Archivo | Qué es |
| --- | --- |
| `main.js` | Bandeja, cartel, lanzamiento de la barra en Chrome `--app` |
| `detector.js` | Vigía de Zoom (tasklist `CptHost.exe`; inyectable para pruebas) |
| `puente.js` | Servidorcito local 127.0.0.1:47125 que la barra consulta |
| `cartel.html` | El cartel "¿querés grabarla?" con el sí automático |
| `preload-cartel.js` | Único canal del cartel hacia la app (sí/no) |

La lógica pura (detector, puente, cartel) se prueba sin Electron ni Windows:
ver `pruebas/sim_escritorio.js`.
