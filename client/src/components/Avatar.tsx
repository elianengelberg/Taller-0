import { useEffect, useState } from "react";
import { avatarColorFor, initialsFor } from "../lib/avatar";

interface Props {
  name: string;
  src?: string | null;
  /** Lado en píxeles. 20-24 para subtítulos, 32-40 para listas, 96 para el perfil. */
  size?: number;
  className?: string;
  /** Anillo blanco alrededor, para cuando va sobre el video. */
  ring?: boolean;
}

// Foto de perfil redonda con respaldo a las iniciales.
//
// El respaldo no es un caso raro: los invitados sin cuenta no tienen foto, y
// una cuenta con email/contraseña tampoco hasta que suba una. Las iniciales
// sobre un color estable por persona se leen tan rápido como una foto, así que
// el diseño nunca queda con un hueco.
export default function Avatar({ name, src, size = 24, className = "", ring }: Props) {
  // Una URL rota (foto de Google borrada, bucket caído) mostraría el icono de
  // imagen partida del navegador; al fallar, se vuelve a las iniciales.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const showImage = Boolean(src) && !failed;
  const style = {
    width: size,
    height: size,
    ...(showImage ? {} : { background: avatarColorFor(name) }),
  };

  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full ${
        ring ? "ring-2 ring-white/70" : ""
      } ${className}`}
      style={style}
      // El nombre ya se muestra al lado en todos los usos, así que para un
      // lector de pantalla la foto es decorativa y repetirlo sería ruido.
      aria-hidden
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="font-semibold leading-none text-white"
          style={{ fontSize: Math.max(9, Math.round(size * 0.4)) }}
        >
          {initialsFor(name)}
        </span>
      )}
    </span>
  );
}
