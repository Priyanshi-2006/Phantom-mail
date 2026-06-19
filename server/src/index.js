require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { db, initDB } = require('./db/database');

const app = express();
const server = http.createServer(app);

// CORS allowed origins config
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:5174'];

// Socket.io attached to the same HTTP server
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));

const rateLimit = require('express-rate-limit');

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in 15 minutes.' }
});

// Apply rate limiters
app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Make io available to route handlers via req.app.get('io')
app.set('io', io);

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/keys',     require('./routes/keys'));
app.get('/api/health',   (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── WebSocket: auth middleware ─────────────────────────────────
// Verify the JWT the client sends on connect.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// ── WebSocket: connection handler ─────────────────────────────
// Each user joins a private room keyed to their alias.
// The messages route emits 'new_message' to that room when they receive mail.
io.on('connection', (socket) => {
  socket.join(socket.user.alias);
  console.log(`  ⚡ ${socket.user.alias} connected via WebSocket`);

  // Update last_seen in database on connection
  db.prepare('UPDATE users SET last_seen = ? WHERE alias = ?')
    .run(Date.now(), socket.user.alias)
    .catch(err => console.error('Failed to update last_seen on connect:', err));

  socket.on('disconnect', () => {
    console.log(`  ✗ ${socket.user.alias} disconnected`);
    
    // Update last_seen in database on disconnection
    db.prepare('UPDATE users SET last_seen = ? WHERE alias = ?')
      .run(Date.now(), socket.user.alias)
      .catch(err => console.error('Failed to update last_seen on disconnect:', err));
  });
});

// ── Start ─────────────────────────────────────────────────────
async function start() {
  await initDB();
  server.listen(PORT, () => {
    console.log(`\n🔒 PhantomMail server → http://localhost:${PORT}`);
    console.log(`   WebSocket (Socket.io) : ACTIVE`);
    console.log(`   Timestamp obfuscation : ±2h noise ACTIVE`);
    console.log(`   IP logging            : DISABLED\n`);
  });
}

start();
