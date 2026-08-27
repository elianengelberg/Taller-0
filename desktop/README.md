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
