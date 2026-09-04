// El puente local entre la app de escritorio y la barra acompañante web.
//
// La barra corre en el navegador (unify-meet.com) y no tiene forma de saber
// cuándo la app de Zoom cerró la reunión: eso lo ve la app de escritorio. El
// canal es este servidorcito HTTP en 127.0.0.1:47125 -- los navegadores
// permiten que una página https consulte 127.0.0.1 (se considera origen
// confiable, exento de "mixed content"), y el CSP del sitio lo lista.
//
// Sólo escucha en la interfaz local (nunca 0.0.0.0) y sólo cuenta un booleano:
// "la reunión sigue". Nada sensible viaja por acá.

const http = require("http");

const PUERTO_PUENTE = 47125;

// Quién puede preguntar: la web de Unify y las direcciones locales.
const ORIGENES_PERMITIDOS = ["https://unify-meet.com", "https://www.unify-meet.com"];
function origenPermitido(origen) {
  if (ORIGENES_PERMITIDOS.includes(origen)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen);
}

function crearPuente({ puerto = PUERTO_PUENTE, estadoExtra = {} } = {}) {
  let enReunion = false;

  const server = http.createServer((req, res) => {
    // CORS ACOTADO: sólo la web de Unify (y localhost, para desarrollo y
    // pruebas) puede leer el estado. Era "*": el dato es inocuo, pero un
    // puerto local abierto a cualquier página es la clase de cosa que un
    // antivirus (con razón) mira con desconfianza.
    const origen = req.headers.origin;
    if (origen) {
      if (!origenPermitido(origen)) {
        res.statusCode = 403;
        res.setHeader("Cache-Control", "no-store");
        res.end("{}");
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origen);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const ruta = (req.url || "/").split("?")[0];
    if (req.method === "GET" && ruta === "/estado") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ app: "unify-escritorio", enReunion, ...estadoExtra }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  const listo = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(puerto, "127.0.0.1", () => resolve());
  });

  return {
    listo,
    fijarEstado(valor) {
      enReunion = !!valor;
    },
    get enReunion() {
      return enReunion;
    },
    cerrar() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { crearPuente, PUERTO_PUENTE, origenPermitido };
