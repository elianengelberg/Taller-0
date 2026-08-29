// QUÉ APARATO ES ESTE, en un solo lugar.
//
// La app da instrucciones todo el tiempo -- cómo instalarla, cómo destrabar el
// micrófono, cómo ver la reunión y los subtítulos a la vez, dónde está la
// dirección iCal de Google --, y esas instrucciones NO son las mismas en un
// iPhone, un iPad, Windows o Android. Antes cada pantalla detectaba por su
// cuenta (o peor: mostraba las de todos los aparatos juntas y que la persona
// buscara la suya). Acá se decide UNA vez y todos hablan del mismo aparato.

export type Sistema = "windows" | "mac" | "ios" | "android" | "linux" | "otro";
export type Navegador = "chrome" | "edge" | "safari" | "firefox" | "otro";

export interface Dispositivo {
  sistema: Sistema;
  navegador: Navegador;
  /** iPad (incluso el que se disfraza de Mac) frente a iPhone. */
  esTablet: boolean;
  esTelefono: boolean;
  /** Windows, Mac o Linux: teclado, mouse y ventanas. */
  esCompu: boolean;
  /** Cómo se llama en pantalla: "tu iPad", "tu iPhone", "Windows"… */
  nombre: string;
  /** Nombre corto para títulos: "iPad", "iPhone", "Windows"… */
  corto: string;
}

// iPadOS se disfraza de Mac desde iPadOS 13: el user agent dice "Macintosh" y
// lo único que lo delata es que la pantalla se toca.
function esIpadDisfrazado(ua: string, tactil: number): boolean {
  return /iPad/.test(ua) || (/Mac/.test(ua) && tactil > 1);
}

export function detectarDispositivo(): Dispositivo {
  if (typeof navigator === "undefined") {
    return { sistema: "otro", navegador: "otro", esTablet: false, esTelefono: false, esCompu: true, nombre: "tu equipo", corto: "tu equipo" };
  }
  const ua = navigator.userAgent;
  const tactil = navigator.maxTouchPoints ?? 0;
  const ipad = esIpadDisfrazado(ua, tactil);
  const iphone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  // Un Android con pantalla grande y sin "Mobile" en el UA es una tablet.
  const tabletAndroid = android && !/Mobile/.test(ua);

  const sistema: Sistema = ipad || iphone
    ? "ios"
    : android
      ? "android"
      : /Win/.test(ua)
        ? "windows"
        : /Mac/.test(ua)
          ? "mac"
          : /Linux|X11/.test(ua)
            ? "linux"
            : "otro";

  // El orden importa: Edge dice "Chrome" y "Safari" en su user agent, y Chrome
  // de iPhone se anuncia como CriOS. Se pregunta del más específico al más
  // general para no confundirlos.
  const navegador: Navegador = /Edg\/|EdgiOS/i.test(ua)
    ? "edge"
    : /CriOS|Chrome|Chromium/i.test(ua)
      ? "chrome"
      : /FxiOS|Firefox/i.test(ua)
        ? "firefox"
        : /Safari/i.test(ua)
          ? "safari"
          : "otro";

  const esTablet = ipad || tabletAndroid;
  const esTelefono = iphone || (android && !tabletAndroid);
  const corto = ipad
    ? "iPad"
    : iphone
      ? "iPhone"
      : tabletAndroid
        ? "tu tablet"
        : android
          ? "tu teléfono"
          : sistema === "windows"
            ? "Windows"
            : sistema === "mac"
              ? "Mac"
              : sistema === "linux"
                ? "Linux"
                : "tu equipo";
  return {
    sistema,
    navegador,
    esTablet,
    esTelefono,
    esCompu: !esTablet && !esTelefono,
    nombre: corto.startsWith("tu") ? corto : `tu ${corto}`,
    corto,
  };
}

/**
 * ¿iPhone o iPad? En iOS el micrófono es de UN SOLO dueño a la vez: si el
 * reconocimiento de voz (subtítulos) y una grabación por getUserMedia corren
 * juntos, el sistema les corta el audio a los dos en silencio.
 */
export function esIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPod/.test(ua) || esIpadDisfrazado(ua, navigator.maxTouchPoints ?? 0);
}

/** Cómo se destraba el micrófono EN ESTE aparato, con su camino real. */
export function comoDesbloquearMicrofono(d = detectarDispositivo()): string {
  if (d.sistema === "ios") {
    return `En ${d.corto}: Ajustes → Safari (o la app de Unify) → Micrófono, ponelo en Permitir. Después volvé y tocá Reintentar.`;
  }
  if (d.sistema === "android") {
    return "En Android: tocá el candado (o el ícono de la izquierda) en la barra de direcciones → Permisos → Micrófono → Permitir. Después tocá Reintentar.";
  }
  if (d.navegador === "firefox") {
    return "En Firefox: hacé clic en el candado de la barra de direcciones → Conexión segura → Más información → Permisos, y destildá «Usar predeterminado» en Micrófono. Después tocá Reintentar.";
  }
  const menu = d.navegador === "edge" ? "Configuración del sitio" : "Configuración de sitios";
  return `En ${d.corto}: hacé clic en el candado (o el ícono a la izquierda de la dirección) → ${menu} → Micrófono → Permitir. Después tocá Reintentar.`;
}

/**
 * Cómo ver la reunión y los subtítulos AL MISMO TIEMPO en este aparato. Es la
 * pregunta que más se repite, y la respuesta es distinta en cada uno.
 */
export function comoVerLosDosALaVez(d = detectarDispositivo()): string {
  if (d.corto === "iPad") {
    return "En el iPad podés ver las dos cosas: deslizá desde abajo para abrir Split View y dejá Meet de un lado y Unify del otro. O usá los subtítulos flotantes, que quedan encima de cualquier app.";
  }
  if (d.corto === "iPhone") {
    return "En el iPhone entrá a la reunión y tocá los subtítulos flotantes: quedan en una ventanita encima de la app de la llamada. También podés dejar la reunión sonando en altavoz en otro aparato y leer acá.";
  }
  if (d.sistema === "android") {
    return "En Android usá los subtítulos flotantes: quedan en una ventanita encima de la app de la reunión. O abrí la reunión en pantalla dividida con Unify al lado.";
  }
  if (d.sistema === "windows") {
    return "En Windows poné las dos ventanas lado a lado (tecla Windows + ← y →): la reunión de un lado, Unify del otro. Los subtítulos flotantes también funcionan y quedan siempre encima.";
  }
  if (d.sistema === "mac") {
    return "En Mac poné las dos ventanas lado a lado (o usá Split View desde el botón verde): la reunión de un lado, Unify del otro. Los subtítulos flotantes también quedan siempre encima.";
  }
  return "Poné la reunión y Unify lado a lado, o usá los subtítulos flotantes, que quedan encima de cualquier ventana.";
}
