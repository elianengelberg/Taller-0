import { Navigate, Route, Routes } from "react-router-dom";
import CalendarRecordWatcher from "./components/CalendarRecordWatcher";
import RequireAuth from "./components/RequireAuth";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { MeetingProvider } from "./context/MeetingContext";
import ExternalJoin from "./pages/ExternalJoin";
import ExternalMeeting from "./pages/ExternalMeeting";
import GoogleCallback from "./pages/GoogleCallback";
import HostSetup from "./pages/HostSetup";
import History from "./pages/History";
import JoinForm from "./pages/JoinForm";
import Login from "./pages/Login";
import Meeting from "./pages/Meeting";
import MeetingDetail from "./pages/MeetingDetail";
import Home from "./pages/Home";
import Register from "./pages/Register";

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <MeetingProvider>
        {/* Global: watches the connected Outlook calendar and offers to
            record meetings as they start, on any page while logged in. */}
        <CalendarRecordWatcher />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/ingresar" element={<Login />} />
          <Route path="/registrarse" element={<Register />} />
          {/* Landing spot for the Google OAuth redirect (see googleAuth.ts). */}
          <Route path="/auth/google" element={<GoogleCallback />} />
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
