import { COMPANION_ROLES, RoleMap, roleById } from "../lib/companionRoles";
import SidePanel from "./SidePanel";

interface Props {
  /** Quiénes hablaron hasta ahora (de la transcripción) + quiénes están en la sala. */
  people: string[];
  roles: RoleMap;
  onChange: (name: string, roleId: string) => void;
  onClose: () => void;
  side?: "left" | "right";
}

// Etiquetá a cada persona de la reunión externa. Los roles son locales a este
// dispositivo (una sala companion no tiene anfitrión que los reparta), y sirven
// para leer después quién dijo qué: el badge acompaña a cada línea, tanto en los
// subtítulos como en la transcripción.
export default function CompanionRolesPanel({ people, roles, onChange, onClose, side }: Props) {
  return (
    <SidePanel title="Roles" onClose={onClose} side={side}>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        Poné una etiqueta a cada persona: aparece en los subtítulos y en la transcripción. Es tuya,
        no la ven los demás.
      </p>

      {people.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-600 p-4 text-center text-xs text-ink-400">
          Las personas aparecen acá en cuanto hablan.
        </p>
      ) : (
        <ul className="space-y-2">
          {people.map((name) => {
            const role = roleById(roles[name]);
            return (
              <li
                key={name}
                className="flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-800/60 p-2.5"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: role.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-strong">{name}</span>
                <select
                  aria-label={`Rol de ${name}`}
                  value={roles[name] ?? ""}
                  onChange={(e) => onChange(name, e.target.value)}
                  className="max-w-[8.5rem] shrink-0 truncate rounded-lg border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-strong focus:border-brand-400 focus:outline-none"
                >
                  {COMPANION_ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </SidePanel>
  );
}
