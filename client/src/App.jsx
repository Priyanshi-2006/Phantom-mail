import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import InboxPage from './pages/InboxPage';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ background: '#0a0b0e', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00e5a0', fontFamily: 'monospace', fontSize: '13px' }}>
        Loading PhantomMail…
      </div>
    );
  }
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/"      element={<PrivateRoute><InboxPage /></PrivateRoute>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
