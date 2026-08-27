import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { useMeeting } from "../context/MeetingContext";
import { roleColorStyle } from "../lib/roleColors";
import { LANGUAGES, idiomaDelDispositivo, recordarIdioma } from "../lib/languages";
import { cardClass, inputClass, labelClass, nameInputProps, sentenceInputProps } from "../lib/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function HostSetup() {
  useDocumentTitle("Nueva reunión");
  const navigate = useNavigate();
  const { startHostDraft, prewarm } = useMeeting();
  const { user } = useAuth();
  // Warm the backend/socket while they set up roles, so creating is instant.
  useEffect(() => prewarm(), [prewarm]);
  const [name, setName] = useState("");
  // Prefill the host name from the logged-in account (once it loads), without
  // clobbering anything they've already typed.
  useEffect(() => {
    if (user?.name) setName((current) => current || user.name);
  }, [user]);
  // Arranca en el idioma del APARATO (o el último elegido).
  const [language, setLanguage] = useState(idiomaDelDispositivo);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [roleInput, setRoleInput] = useState("");

  function addRole() {
    const value = roleInput.trim();
    if (!value) return;
    if (roleNames.some((r) => r.toLowerCase() === value.toLowerCase())) {
      setRoleInput("");
      return;
    }
    setRoleNames((prev) => [...prev, value]);
    setRoleInput("");
  }

  function handleRoleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addRole();
    }
  }

  function removeRole(name: string) {
    setRoleNames((prev) => prev.filter((r) => r !== name));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    startHostDraft({ name, language, roleNames });
    navigate("/reunion");
  }

  // Deja asomar una franja del pie (banda azul) abajo, sin scrollear.
  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)] flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-lg">
        <Logo className="mb-8" />
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-strong">Crear una reunión</h1>
          <p className="mt-1 text-sm text-ink-300">
            Definí los roles disponibles antes de arrancar. Vas a poder asignarlos a cada
            participante durante la reunión (y también agregar más roles en el momento).
          </p>

          <form className="mt-6 space-y-6" onSubmit={handleSubmit}>
            <div>
              <label className={labelClass} htmlFor="name">
                Tu nombre (anfitrión)
              </label>
              <input
                id="name"
                className={inputClass}
                placeholder="Ej: Elian"
                {...nameInputProps}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="language">
                Idioma en el que hablás
              </label>
              <select
                id="language"
                className={inputClass}
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  recordarIdioma(e.target.value);
                }}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-ink-400">
                Se usa para traducir automáticamente el chat a tu idioma cuando alguien active
                esa opción.
              </p>
            </div>

            <div>
              <label className={labelClass} htmlFor="role-input">
                Roles de la reunión
              </label>
              <div className="flex gap-2">
                <input
                  id="role-input"
                  className={inputClass}
                  placeholder="Ej: Ingeniero civil"
                  {...sentenceInputProps}
                  value={roleInput}
                  onChange={(e) => setRoleInput(e.target.value)}
                  onKeyDown={handleRoleKeyDown}
                  maxLength={40}
                />
                <Button type="button" variant="secondary" onClick={addRole}>
                  Agregar
                </Button>
              </div>

              {roleNames.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {roleNames.map((role, index) => {
                    const style = roleColorStyle(index);
                    return (
                      <span
                        key={role}
                        title={role}
                        className={`inline-flex max-w-[14rem] items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ${style.bg} ${style.text}`}
                      >
                        <span className="truncate">{role}</span>
                        <button
                          type="button"
                          onClick={() => removeRole(role)}
                          aria-label={`Quitar rol ${role}`}
                          className="rounded-full text-current opacity-70 hover:opacity-100"
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-400">
                  Todavía no agregaste roles. Podés dejarlo vacío y crearlos más tarde.
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={() => navigate("/")}>
                Volver
              </Button>
              <Button type="submit" className="flex-1">
                Iniciar reunión
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
