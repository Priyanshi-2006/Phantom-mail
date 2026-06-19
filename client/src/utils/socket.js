import { io } from 'socket.io-client';

let socket = null;

/**
 * Connect to the WebSocket server.
 * Called once after login, passing the JWT so the server can verify identity.
 */
export function connectSocket(token) {
  if (socket) {
    if (socket.disconnected) {
      socket.auth = { token };
      socket.connect();
    }
    return socket;
  }

  const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
  socket = io(serverUrl, {
    auth: { token },
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  socket.on('connect', () => {
    console.log('⚡ WebSocket connected:', socket.id);
  });

  socket.on('connect_error', (err) => {
    console.warn('WebSocket error:', err.message);
  });

  return socket;
}

/** Disconnect and clean up — call on logout */
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Get the current socket instance (may be null if not connected) */
export function getSocket() {
  return socket;
}
