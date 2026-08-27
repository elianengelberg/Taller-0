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

function crearPuente({ puerto = PUERTO_PUENTE } = {}) {
  let enReunion = false;

  const server = http.createServer((req, res) => {
    // CORS abierto: el dato es un booleano público para la página que lo pida.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    const ruta = (req.url || "/").split("?")[0];
    if (req.method === "GET" && ruta === "/estado") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ app: "unify-escritorio", enReunion }));
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

module.exports = { crearPuente, PUERTO_PUENTE };
