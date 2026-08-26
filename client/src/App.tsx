import { Navigate, Route, Routes } from "react-router-dom";
import CalendarRecordWatcher from "./components/CalendarRecordWatcher";
import EnlaceCopiado from "./components/EnlaceCopiado";
import RequireAuth from "./components/RequireAuth";
import ToastViewport from "./components/ToastViewport";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { MeetingProvider } from "./context/MeetingContext";
import ExternalJoin from "./pages/ExternalJoin";
import ExternalMeeting from "./pages/ExternalMeeting";
import ForgotPassword from "./pages/ForgotPassword";
import GoogleCallback from "./pages/GoogleCallback";
import HostSetup from "./pages/HostSetup";
import History from "./pages/History";
import JoinForm from "./pages/JoinForm";
import Login from "./pages/Login";
import Meeting from "./pages/Meeting";
import MeetingDetail from "./pages/MeetingDetail";
import Home from "./pages/Home";
import Instalar from "./pages/Instalar";
import Privacidad from "./pages/Privacidad";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import Soporte from "./pages/Soporte";
import VerifyEmail from "./pages/VerifyEmail";

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <MeetingProvider>
        {/* Global: watches the connected Outlook calendar and offers to
            record meetings as they start, on any page while logged in. */}
        <CalendarRecordWatcher />
        {/* Global: el cartel del enlace copiado, en cualquier pantalla de la
            app (ver EnlaceCopiado.tsx). */}
        <EnlaceCopiado />
        {/* Global: los avisos (actualización de la PWA, pedidos del anfitrión)
            se ven en cualquier página, no sólo dentro de la reunión. */}
        <ToastViewport />
        <Routes>
          <Route path="/" element={<Home />} />
          {/* El centro de instalación: la app (PWA) y la extensión. */}
          <Route path="/instalar" element={<Instalar />} />
          <Route path="/privacidad" element={<Privacidad />} />
          {/* La URL de asistencia de la ficha de la Chrome Web Store. */}
          <Route path="/soporte" element={<Soporte />} />
          <Route path="/ingresar" element={<Login />} />
          <Route path="/registrarse" element={<Register />} />
          {/* Landing spot for the Google OAuth redirect (see googleAuth.ts). */}
          <Route path="/auth/google" element={<GoogleCallback />} />
          {/* Donde aterrizan los enlaces que mandamos por correo. El token
              viaja en el fragmento (#token=…), así que nunca llega al
              servidor de la web ni a sus logs. */}
          <Route path="/verificar-email" element={<VerifyEmail />} />
          <Route path="/recuperar" element={<ForgotPassword />} />
          <Route path="/restablecer" element={<ResetPassword />} />
          <Route path="/crear" element={<HostSetup />} />
          <Route path="/unirse" element={<JoinForm />} />
          {/* Zoom-style direct-join link (see ShareMenu) -- same form, minus
              the code field, since it's already in the URL. */}
          <Route path="/unirse/:code" element={<JoinForm />} />
          {/* Join a meeting hosted on another platform (paste a Zoom/Meet/Jitsi link). */}
          <Route path="/externa" element={<ExternalJoin />} />
          {/* The embedded external meeting + Unify's transcript/AI overlay. */}
          <Route path="/externa/reunion" element={<ExternalMeeting />} />
          <Route path="/reunion" element={<Meeting />} />
          {/* History is private per account -- gated behind login. */}
          <Route
            path="/historial"
            element={
              <RequireAuth>
                <History />
              </RequireAuth>
            }
          />
          <Route
            path="/historial/:id"
            element={
              <RequireAuth>
                <MeetingDetail />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MeetingProvider>
    </AuthProvider>
    </ThemeProvider>
  );
}
