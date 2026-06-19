import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:3001/api' });

// Attach saved JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('pm_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// If token expired, kick back to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 403) {
      localStorage.removeItem('pm_token');
      localStorage.removeItem('pm_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
