import { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { CaptionsIcon, GlobeIcon, PeopleIcon, SparklesIcon } from "../components/icons";
import { cardClass } from "../lib/ui";

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col bg-ink-950">
      <header className="flex items-center justify-between gap-3 px-5 py-5 sm:px-10 sm:py-6">
        <Logo />
        <div className="flex items-center gap-4 sm:gap-6">
          <Link
            to="/externa"
            className="hidden whitespace-nowrap text-sm font-medium text-ink-300 hover:text-white sm:block"
          >
            Reunión externa
          </Link>
          <Link
            to="/historial"
            className="whitespace-nowrap text-sm font-medium text-ink-300 hover:text-white"
          >
            Historial
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-6 pb-20 pt-6">
        <div className="w-full max-w-4xl text-center">
          <span className="inline-block rounded-full bg-brand-500/15 px-4 py-1.5 text-sm font-medium text-brand-300">
            Subtítulos, traducción y un asistente de IA en cada reunión
          </span>
          <h1 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl">
            Reuniones claras, con cada voz identificada
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-300">
            Creá reuniones con roles y transcripción en vivo — o sumale los subtítulos, la traducción
            y la IA de Encuentro a tus llamadas de Zoom, Teams o Meet.
          </p>

          <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-3">
            <ActionCard
              title="Crear una reunión"
              description="Definí roles para tu equipo y arrancá una reunión de Encuentro."
              cta={
                <Button className="mt-5 w-full" onClick={() => navigate("/crear")}>
                  Crear reunión
                </Button>
              }
            />
            <ActionCard
              title="Tengo un código"
              description="Sumate a una reunión de Encuentro que ya está en marcha."
              cta={
                <Button variant="secondary" className="mt-5 w-full" onClick={() => navigate("/unirse")}>
                  Unirme con código
                </Button>
              }
            />
            <ActionCard
              highlight
              title="Zoom · Teams · Meet"
              description="Pegá el enlace de una reunión externa y usá las funciones de Encuentro encima."
              cta={
                <Button className="mt-5 w-full" onClick={() => navigate("/externa")}>
                  Unirme a una externa
                </Button>
              }
            />
          </div>

          <ul className="mx-auto mt-14 grid max-w-3xl gap-4 text-left sm:grid-cols-2">
            <FeatureItem
              icon={<PeopleIcon className="h-5 w-5" />}
              title="Roles en vivo"
              description="El anfitrión asigna roles a cada persona durante la reunión, y cada frase queda anotada con quién la dijo."
            />
            <FeatureItem
              icon={<CaptionsIcon className="h-5 w-5" />}
              title="Subtítulos y traducción"
              description="Transcripción en vivo con nombre, traducida al instante al idioma que elija cada uno."
            />
            <FeatureItem
              icon={<SparklesIcon className="h-5 w-5" />}
              title="Asistente de IA"
              description="Preguntale a la IA durante la reunión: resúmenes, conclusiones y qué se dijo, en el momento."
            />
            <FeatureItem
              icon={<GlobeIcon className="h-5 w-5" />}
              title="Sobre otras plataformas"
              description="Llevá los subtítulos, la traducción y la IA a tus reuniones de Zoom, Teams o Jitsi."
            />
          </ul>
        </div>
      </main>
    </div>
  );
}

function ActionCard({
  title,
  description,
  cta,
  highlight,
}: {
  title: string;
  description: string;
  cta: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex flex-col ${cardClass} ${
        highlight ? "border-brand-500/60 ring-1 ring-brand-500/30" : ""
      }`}
    >
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mt-1.5 flex-1 text-sm text-ink-300">{description}</p>
      {cta}
    </div>
  );
}

function FeatureItem({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className="flex gap-3 rounded-xl border border-ink-700 bg-ink-800 p-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">
        {icon}
      </span>
      <div>
        <p className="font-semibold text-white">{title}</p>
        <p className="mt-1 text-sm text-ink-300">{description}</p>
      </div>
    </li>
  );
}
