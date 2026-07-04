import { Navigate, Route, Routes } from "react-router-dom";
import { MeetingProvider } from "./context/MeetingContext";
import ExternalJoin from "./pages/ExternalJoin";
import ExternalMeeting from "./pages/ExternalMeeting";
import HostSetup from "./pages/HostSetup";
import History from "./pages/History";
import JoinForm from "./pages/JoinForm";
import Meeting from "./pages/Meeting";
import MeetingDetail from "./pages/MeetingDetail";
import Home from "./pages/Home";

export default function App() {
  return (
    <MeetingProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/crear" element={<HostSetup />} />
        <Route path="/unirse" element={<JoinForm />} />
        {/* Zoom-style direct-join link (see ShareMenu) -- same form, minus
            the code field, since it's already in the URL. */}
        <Route path="/unirse/:code" element={<JoinForm />} />
        {/* Join a meeting hosted on another platform (paste a Zoom/Meet/Jitsi link). */}
        <Route path="/externa" element={<ExternalJoin />} />
        {/* The embedded external meeting + Encuentro's transcript/AI overlay. */}
        <Route path="/externa/reunion" element={<ExternalMeeting />} />
        <Route path="/reunion" element={<Meeting />} />
        <Route path="/historial" element={<History />} />
        <Route path="/historial/:id" element={<MeetingDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MeetingProvider>
  );
}
