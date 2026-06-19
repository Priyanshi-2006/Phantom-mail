/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';
import api from '../utils/api';
import { connectSocket, disconnectSocket } from '../utils/socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);

  // Manage WebSocket connection based on authentication state
  useEffect(() => {
    const token = localStorage.getItem('pm_token');
    if (user && token) {
      const s = connectSocket(token);

      const onConnect = () => setSocketConnected(true);
      const onDisconnect = () => setSocketConnected(false);

      if (s.connected) {
        Promise.resolve().then(() => setSocketConnected(true));
      } else {
        Promise.resolve().then(() => setSocketConnected(false));
      }

      s.on('connect', onConnect);
      s.on('disconnect', onDisconnect);

      return () => {
        s.off('connect', onConnect);
        s.off('disconnect', onDisconnect);
      };
    } else {
      disconnectSocket();
      Promise.resolve().then(() => setSocketConnected(false));
    }
  }, [user]);

  // Restore session on page load
  useEffect(() => {
    const token = localStorage.getItem('pm_token');
    const saved = localStorage.getItem('pm_user');
    if (token && saved) {
      const parsedUser = JSON.parse(saved);
      Promise.resolve().then(() => setUser(parsedUser));
    }
    Promise.resolve().then(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    localStorage.setItem('pm_token', res.data.token);
    localStorage.setItem('pm_user', JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data;
  };

  const register = async (username, email, password) => {
    const res = await api.post('/auth/register', { username, email, password });
    localStorage.setItem('pm_token', res.data.token);
    localStorage.setItem('pm_user', JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data;
  };

  const logout = () => {
    ['pm_token', 'pm_user', 'pm_private_key'].forEach(k => localStorage.removeItem(k));
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, register, logout, loading, socketConnected }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
