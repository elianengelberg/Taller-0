// Roles para reuniones externas (Zoom/Meet/Teams/Jitsi).
//
// En una reunión propia los roles los asigna el anfitrión y viajan por el
// servidor. Una sala companion no tiene anfitrión -- es un grupo plano de gente
// tomando notas sobre una reunión que vive en otra plataforma -- así que acá los
// roles son una etiqueta LOCAL: cada quien rotula a los demás como los ve, y se
// recuerda por reunión en este dispositivo. Sirve para leer la transcripción
// después ("esto lo dijo el cliente") sin depender de permisos que no existen.

export interface CompanionRole {
  id: string;
  label: string;
  /** Color del badge; se usa tal cual en estilos en línea. */
  color: string;
}

export const COMPANION_ROLES: CompanionRole[] = [
  { id: "", label: "Sin rol", color: "#94a3b8" },
  { id: "anfitrion", label: "Anfitrión", color: "#34d399" },
  { id: "cliente", label: "Cliente", color: "#60a5fa" },
  { id: "equipo", label: "Equipo", color: "#a78bfa" },
  { id: "invitado", label: "Invitado", color: "#fbbf24" },
];

export function roleById(id: string | undefined | null): CompanionRole {
  return COMPANION_ROLES.find((r) => r.id === (id ?? "")) ?? COMPANION_ROLES[0];
}

const key = (meetingKey: string) => `unify_roles_${meetingKey}`;

export type RoleMap = Record<string, string>;

export function loadRoles(meetingKey: string): RoleMap {
  try {
    const raw = localStorage.getItem(key(meetingKey));
    return raw ? (JSON.parse(raw) as RoleMap) : {};
  } catch {
    return {};
  }
}

export function saveRoles(meetingKey: string, roles: RoleMap): void {
  try {
    localStorage.setItem(key(meetingKey), JSON.stringify(roles));
  } catch {
    /* almacenamiento bloqueado: los roles duran lo que la sesión */
  }
}
