import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { cardClass } from "../lib/ui";

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col bg-sand-100">
      <header className="px-6 py-6 sm:px-10">
        <Logo />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-3xl text-center">
          <span className="inline-block rounded-full bg-brand-100 px-4 py-1.5 text-sm font-medium text-brand-700">
            Videollamadas con roles, subtítulos y traducción en vivo
          </span>
          <h1 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight text-ink-900 sm:text-5xl">
            Reuniones claras, con cada voz identificada
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-ink-500">
            Creá roles para tu equipo, asignalos durante la llamada y seguí en vivo quién dice
            qué — con traducción automática incluida.
          </p>

          <div className="mx-auto mt-10 grid max-w-xl gap-4 sm:grid-cols-2">
            <div className={cardClass}>
              <h2 className="text-lg font-semibold text-ink-900">Soy anfitrión</h2>
              <p className="mt-1.5 text-sm text-ink-500">
                Definí los roles de tu reunión antes de empezar.
              </p>
              <Button className="mt-5 w-full" onClick={() => navigate("/crear")}>
                Crear una reunión
              </Button>
            </div>
            <div className={cardClass}>
              <h2 className="text-lg font-semibold text-ink-900">Tengo un código</h2>
              <p className="mt-1.5 text-sm text-ink-500">
                Sumate a una reunión que ya está en marcha.
              </p>
              <Button
                variant="secondary"
                className="mt-5 w-full"
                onClick={() => navigate("/unirse")}
              >
                Unirme a una reunión
              </Button>
            </div>
          </div>

          <ul className="mx-auto mt-14 grid max-w-2xl gap-4 text-left sm:grid-cols-3">
            <FeatureItem
              title="Roles en vivo"
              description="El anfitrión asigna roles a cada persona durante la reunión."
            />
            <FeatureItem
              title="Transcripción con nombre"
              description="Cada frase queda anotada con quién la dijo y su rol."
            />
            <FeatureItem
              title="Traducción al instante"
              description="Subtítulos y chat se traducen al idioma que elijas."
            />
          </ul>
        </div>
      </main>
    </div>
  );
}

function FeatureItem({ title, description }: { title: string; description: string }) {
  return (
    <li className="rounded-xl border border-sand-200 bg-white p-4">
      <p className="font-semibold text-ink-900">{title}</p>
      <p className="mt-1 text-sm text-ink-500">{description}</p>
    </li>
  );
}
