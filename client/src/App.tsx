import { Navigate, Route, Routes } from "react-router-dom";
import { MeetingProvider } from "./context/MeetingContext";
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
        <Route path="/reunion" element={<Meeting />} />
        <Route path="/historial" element={<History />} />
        <Route path="/historial/:id" element={<MeetingDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MeetingProvider>
  );
}
