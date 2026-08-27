import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { useMeeting } from "../context/MeetingContext";
import { LANGUAGES } from "../lib/languages";
import { cardClass, codeInputProps, inputClass, labelClass, nameInputProps, normalizeMeetingCode } from "../lib/ui";

export default function JoinForm() {
  const navigate = useNavigate();
  const { startJoinDraft, prewarm } = useMeeting();
  // Warm the backend/socket while they type their name, so joining is instant.
  useEffect(() => prewarm(), [prewarm]);
  // Present when arriving through a direct invite link (see ShareMenu /
  // /unirse/:code) -- the code is already known, so the form skips straight
  // to name + language instead of asking for it again.
  const { code: codeFromUrl } = useParams<{ code?: string }>();
  const [name, setName] = useState("");
  const [meetingCode, setMeetingCode] = useState("");
  const [language, setLanguage] = useState(LANGUAGES[0].code);

  const fixedCode = codeFromUrl ? normalizeMeetingCode(codeFromUrl) || null : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const code = fixedCode ?? normalizeMeetingCode(meetingCode);
    if (!name.trim() || !code) return;
    startJoinDraft({ name, language, meetingCode: code });
    navigate("/reunion");
  }

  // min-h un poco menor que la pantalla: así asoma una franja del pie (la
  // banda azul) abajo de todo, sin tener que scrollear.
  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)] flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-md">
        <Logo className="mb-8" />
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-strong">
            {fixedCode ? `Unirme a la reunión ${fixedCode}` : "Unirme a una reunión"}
          </h1>
          <p className="mt-1 text-sm text-ink-300">
            {fixedCode
              ? "Ingresá tu nombre y el idioma en el que vas a hablar para unirte."
              : "Ingresá el código que te compartió el anfitrión."}
          </p>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            {!fixedCode && (
              <div>
                <label className={labelClass} htmlFor="meetingCode">
                  Código de la reunión
                </label>
                <input
                  id="meetingCode"
                  className={`${inputClass} text-center text-lg font-semibold uppercase tracking-[0.3em]`}
                  placeholder="ABC123"
                  {...codeInputProps}
                  value={meetingCode}
                  // Normalize on every change: accepts a pasted invite link,
                  // strips spaces/dashes and uppercases (see normalizeMeetingCode).
                  onChange={(e) => setMeetingCode(normalizeMeetingCode(e.target.value))}
                  required
                />
              </div>
            )}

            <div>
              <label className={labelClass} htmlFor="name">
                Tu nombre
              </label>
              <input
                id="name"
                className={inputClass}
                placeholder="Ej: Diego"
                {...nameInputProps}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="language">
                Idioma en el que vas a hablar
              </label>
              <select
                id="language"
                className={inputClass}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                className="flex-1"
                onClick={() => navigate("/")}
              >
                Volver
              </Button>
              <Button type="submit" className="flex-1">
                Unirme
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
