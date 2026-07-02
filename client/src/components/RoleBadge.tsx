import { Role } from "../types";
import { roleColorStyle } from "../lib/roleColors";

export default function RoleBadge({ role, size = "md" }: { role: Role | null; size?: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs";

  if (!role) {
    return (
      <span className={`inline-flex items-center rounded-full bg-ink-700 font-medium text-ink-300 ${sizeClass}`}>
        Sin rol
      </span>
    );
  }

  const style = roleColorStyle(role.colorIndex);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${style.bg} ${style.text} ${sizeClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {role.name}
    </span>
  );
}
