// Ejecuta la función REAL del servidor, para que el test no pruebe una copia
// del SQL sino el código que corre en producción.
import { claimAccountForVerifiedEmail } from "/home/user/Taller-0/server/src/db";
const [, , userId, googleId] = process.argv;
claimAccountForVerifiedEmail(userId, googleId).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(0);
});
