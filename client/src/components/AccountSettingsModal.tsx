import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { changePassword, updateProfile } from "../lib/api";
import { cardClass, inputClass, labelClass } from "../lib/ui";
import Button from "./Button";
import { CloseIcon } from "./icons";

// Basic account settings: rename and change password. A centered modal (not
// a SidePanel) since this isn't scoped to a meeting -- it's reachable from
// the header on any page.
export default function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const { user, setUser } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [nameStatus, setNameStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  async function handleSaveName(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSavingName(true);
    setNameStatus(null);
    const res = await updateProfile(name.trim());
    setSavingName(false);
    if (res.error || !res.user) {
      setNameStatus({ kind: "error", text: res.error ?? "No se pudo guardar el nombre." });
      return;
    }
    setUser(res.user);
    setNameStatus({ kind: "ok", text: "Nombre actualizado." });
  }

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < 8) {
      setPasswordStatus({ kind: "error", text: "La nueva contraseña debe tener al menos 8 caracteres." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ kind: "error", text: "Las contraseñas nuevas no coinciden." });
      return;
    }
    setSavingPassword(true);
    setPasswordStatus(null);
    const res = await changePassword(currentPassword, newPassword);
    setSavingPassword(false);
    if (res.error) {
      setPasswordStatus({ kind: "error", text: res.error });
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordStatus({ kind: "ok", text: "Contraseña actualizada." });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className={`${cardClass} w-full max-w-md`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Configuración de la cuenta</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-full p-1.5 text-ink-300 hover:bg-ink-800"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <form className="mt-5 space-y-2" onSubmit={handleSaveName}>
          <label className={labelClass} htmlFor="account-name">
            Nombre
          </label>
          <div className="flex gap-2">
            <input
              id="account-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <Button type="submit" variant="secondary" disabled={savingName || !name.trim()}>
              Guardar
            </Button>
          </div>
          {user?.email && <p className="text-xs text-ink-500">{user.email}</p>}
          {nameStatus && (
            <p className={`text-xs ${nameStatus.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
              {nameStatus.text}
            </p>
          )}
        </form>

        <div className="mt-6 border-t border-ink-700 pt-5">
          <h3 className="text-sm font-semibold text-white">Cambiar contraseña</h3>
          <form className="mt-3 space-y-3" onSubmit={handleChangePassword}>
            <div>
              <label className={labelClass} htmlFor="current-password">
                Contraseña actual
              </label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                className={inputClass}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="new-password">
                Nueva contraseña
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                placeholder="Al menos 8 caracteres"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="confirm-password">
                Confirmar nueva contraseña
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            {passwordStatus && (
              <p className={`text-xs ${passwordStatus.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                {passwordStatus.text}
              </p>
            )}
            <Button
              type="submit"
              variant="secondary"
              className="w-full"
              disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
            >
              Actualizar contraseña
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
