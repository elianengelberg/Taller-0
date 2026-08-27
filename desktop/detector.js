// Detección de "la app de Zoom está en una reunión".
//
// La señal en Windows es el proceso CptHost.exe: Zoom lo levanta al ENTRAR a
// una reunión y lo baja al salir (a diferencia de Zoom.exe, que vive siempre
// que la app esté abierta). No depende del idioma de la interfaz ni de títulos
// de ventana, que cambian con cada localización.
//
// La máquina de estados exige DOS lecturas seguidas iguales antes de avisar:
// una lectura suelta (un tasklist que falló, un proceso a medio morir) no
// tiene que disparar el cartel ni dar por terminada una reunión viva.
//
// `sonda` es inyectable a propósito: en Windows es tasklist; en desarrollo y
// en las pruebas es "existe tal archivo" o una función falsa. Así toda esta
// lógica se prueba sin Zoom y sin Windows.

const { exec } = require("child_process");
const fs = require("fs");

// ¿Está la app de Zoom dentro de una reunión AHORA? (Windows)
function sondaWindows() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq CptHost.exe" /FO CSV /NH', { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/CptHost\.exe/i.test(stdout || ""));
    });
  });
}

// Sonda de desarrollo/pruebas: la "reunión" es que exista un archivo. Tocarlo
// simula entrar; borrarlo, salir. (En Linux/macOS no hay Zoom que mirar.)
function sondaArchivo(ruta) {
  return () => Promise.resolve(fs.existsSync(ruta));
}

// Crea el vigía. Devuelve { detener() }. Llama a `alEntrar()` cuando la
// reunión empieza y `alSalir()` cuando termina (confirmadas, ver arriba).
function crearDetector({ sonda, alEntrar, alSalir, intervaloMs = 3000 }) {
  let enReunion = false;
  let seguidas = 0; // lecturas seguidas que CONTRADICEN el estado actual
  let parado = false;

  async function tick() {
    if (parado) return;
    let lectura = false;
    try {
      lectura = !!(await sonda());
    } catch {
      lectura = false;
    }
    if (lectura === enReunion) {
      seguidas = 0;
    } else {
      seguidas += 1;
      if (seguidas >= 2) {
        enReunion = lectura;
        seguidas = 0;
        try {
          if (enReunion) alEntrar();
          else alSalir();
        } catch {
          // Un error en el aviso no puede matar al vigía.
        }
      }
    }
  }

  const timer = setInterval(() => void tick(), intervaloMs);
  return {
    detener() {
      parado = true;
      clearInterval(timer);
    },
    // Sólo para inspección/pruebas.
    get enReunion() {
      return enReunion;
    },
    // Un tick a mano (pruebas: avanzar sin esperar al reloj).
    _tick: tick,
  };
}

module.exports = { crearDetector, sondaWindows, sondaArchivo };
