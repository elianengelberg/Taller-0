import type { NextFunction, Request, Response } from "express";

// Límites de uso por endpoint.
//
// Hasta acá el único límite del servidor cubría login y registro. Todo lo
// demás estaba abierto, incluidos los endpoints que llaman a Claude y los que
// emiten credenciales de Zoom y de Azure: cualquiera con curl podía dejarnos
// una factura de la nada, sin necesidad de "entrar" a ningún lado. Eso es lo
// que esto cierra.
//
// En memoria y por instancia, que es lo que corresponde a un deploy de un solo
// proceso. Si algún día hay varias instancias esto pasa a ser un límite por
// instancia (más flojo, nunca más estricto), y ahí conviene moverlo a Redis.

interface Bucket {
  count: number;
  windowStart: number;
}

interface LimiterOptions {
  /** Cuántos pedidos se permiten por ventana. */
  max: number;
  /** Largo de la ventana, en milisegundos. */
  windowMs: number;
  /** Mensaje para el 429. */
  message?: string;
  /**
   * De dónde sale la clave. Por defecto la IP; los endpoints que gastan plata
   * y exigen sesión usan el id de usuario, porque es la identidad que de
   * verdad hay que limitar (una IP compartida no debería frenar a una oficina
   * entera, y cambiar de IP no debería saltear el límite).
   */
  keyBy?: (req: Request) => string;
}

const DEFAULT_MESSAGE = "Estás yendo muy rápido. Esperá un momento y probá de nuevo.";
// Tope de claves vivas por limitador: sin esto, pedidos desde muchas IPs
// distintas harían crecer el mapa sin límite hasta tumbar el proceso -- es
// decir, el propio limitador sería el vector de denegación de servicio.
const MAX_KEYS = 20_000;

export function ipOf(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimit(options: LimiterOptions) {
  const { max, windowMs, message = DEFAULT_MESSAGE, keyBy = ipOf } = options;
  const buckets = new Map<string, Bucket>();

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    if (buckets.size > MAX_KEYS) {
      for (const [k, v] of buckets) if (now - v.windowStart > windowMs) buckets.delete(k);
      // Todas vigentes y aun así por encima del tope: se vacía entero. Prefiero
      // perder el conteo un instante antes que quedarme sin memoria.
      if (buckets.size > MAX_KEYS) buckets.clear();
    }
    const key = keyBy(req);
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

/** Por usuario cuando hay sesión; si no, por IP. */
export function userOrIp(req: Request): string {
  const userId = (req as Request & { userId?: string }).userId;
  return userId ? `u:${userId}` : `ip:${ipOf(req)}`;
}
