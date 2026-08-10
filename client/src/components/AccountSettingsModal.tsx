import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { ThemeMode, useTheme } from "../context/ThemeContext";
import { changePassword, fetchPlatformConfig, updateProfile, uploadAvatar } from "../lib/api";
import { prepareAvatar } from "../lib/avatar";
import { cardClass, inputClass, labelClass } from "../lib/ui";
import Avatar from "./Avatar";
import Button from "./Button";
import { CloseIcon } from "./icons";

// Basic account settings: rename and change password. A centered modal (not
// a SidePanel) since this isn't scoped to a meeting -- it's reachable from
// the header on any page.
const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: "light", label: "Claro", hint: "Fondo blanco y celestes suaves" },
  { value: "dark", label: "Oscuro", hint: "Azul oscuro, ideal de noche" },
  { value: "auto", label: "Automático", hint: "Sigue el tema de tu sistema" },
];

export default function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const { user, setUser } = useAuth();
  const { mode, setMode } = useTheme();

  const [name, setName] = useState(user?.name ?? "");
  const [nameStatus, setNameStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);

  // Foto de perfil. `photoPreview` muestra la elegida al instante, sin esperar
  // a que termine la subida: la persona ve el resultado apenas la elige.
  const [photoPreview, setPhotoPreview] = useState<string | null>(user?.avatarUrl ?? null);
  const [photoStatus, setPhotoStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoUploadAllowed, setPhotoUploadAllowed] = useState(true);
  useEffect(() => {
    fetchPlatformConfig().then((c) => setPhotoUploadAllowed(c.avatars !== false));
  }, []);
  useEffect(() => setPhotoPreview(user?.avatarUrl ?? null), [user?.avatarUrl]);

  async function handlePickPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // El input se limpia siempre: si no, volver a elegir la MISMA foto no
    // dispararía el evento y parecería que el botón no anda.
    event.target.value = "";
    if (!file) return;
    setPhotoStatus(null);
    setSavingPhoto(true);
    let localPreview: string | null = null;
    try {
      const prepared = await prepareAvatar(file);
      localPreview = prepared.previewUrl;
      setPhotoPreview(prepared.previewUrl);
      const res = await uploadAvatar(prepared.blob);
      if (res.error || !res.user) {
        setPhotoPreview(user?.avatarUrl ?? null);
        setPhotoStatus({ kind: "error", text: res.error ?? "No se pudo guardar la foto." });
        return;
      }
      setUser(res.user);
      setPhotoStatus({ kind: "ok", text: "Foto actualizada." });
    } catch (err) {
      setPhotoPreview(user?.avatarUrl ?? null);
      setPhotoStatus({
        kind: "error",
        text: err instanceof Error ? err.message : "No se pudo procesar la imagen.",
      });
    } finally {
      // La previsualización local ya cumplió: la definitiva viene del servidor.
      if (localPreview) URL.revokeObjectURL(localPreview);
      setSavingPhoto(false);
    }
  }

  async function handleRemovePhoto() {
    setSavingPhoto(true);
    setPhotoStatus(null);
    const res = await updateProfile(user?.name ?? name.trim(), { avatarUrl: null });
    setSavingPhoto(false);
    if (res.error || !res.user) {
      setPhotoStatus({ kind: "error", text: res.error ?? "No se pudo quitar la foto." });
      return;
    }
    setUser(res.user);
    setPhotoPreview(null);
    setPhotoStatus({ kind: "ok", text: "Foto quitada." });
  }

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
      <div className={`${cardClass} pop-enter max-h-[90dvh] w-full max-w-md overflow-y-auto`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-strong">Configuración de la cuenta</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-full p-1.5 text-ink-300 hover:bg-ink-800"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Foto de perfil: es lo que se ve junto al nombre en los subtítulos
            de cada reunión, así que va primero y en grande. */}
        <div className="mt-5 flex items-center gap-4">
          <Avatar name={user?.name ?? ""} src={photoPreview} size={72} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-strong">Foto de perfil</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
              {photoUploadAllowed
                ? "Se ve junto a tu nombre en los subtítulos de las reuniones."
                : "Este servidor no tiene configurado dónde guardar fotos, así que por ahora no se puede cambiar."}
            </p>
            {photoUploadAllowed && (
              <div className="mt-2 flex flex-wrap gap-2">
                <label
                  className={`cursor-pointer rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-100 hover:bg-ink-800 ${
                    savingPhoto ? "pointer-events-none opacity-60" : ""
                  }`}
                >
                  {savingPhoto ? "Subiendo…" : photoPreview ? "Cambiar foto" : "Subir foto"}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={handlePickPhoto}
                    disabled={savingPhoto}
                  />
                </label>
                {photoPreview && (
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    disabled={savingPhoto}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-60"
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            )}
            {photoStatus && (
              <p
                className={`mt-1.5 text-xs ${
                  photoStatus.kind === "ok" ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {photoStatus.text}
              </p>
            )}
          </div>
        </div>

        <form className="mt-6 space-y-2" onSubmit={handleSaveName}>
          <label className={labelClass} htmlFor="account-name">
            Nombre
          </label>
          <div className="flex gap-2">
            <input
              id="account-name"
              className={inputClass}
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
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
          <h3 className="text-sm font-semibold text-strong">Apariencia</h3>
          <p className="mt-1 text-xs text-ink-400">Elegí el tema de Unify. Se guarda para tus próximas visitas.</p>
          <fieldset className="mt-3 grid gap-2" aria-label="Tema">
            {THEME_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors duration-200 ${
                  mode === option.value
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-ink-700 hover:border-ink-600"
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="h-4 w-4 accent-brand-500"
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium text-strong">{option.label}</span>
                  <span className="block text-xs text-ink-400">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="mt-6 border-t border-ink-700 pt-5">
          <h3 className="text-sm font-semibold text-strong">Cambiar contraseña</h3>
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
