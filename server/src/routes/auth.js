const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function generateAlias() {
  const words = ['ghost','cipher','phantom','shadow','nebula','quark','nova','echo','drift','veil'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.random().toString(16).slice(2, 8)}`;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const id = uuidv4(), alias = generateAlias(), now = Date.now();
    const hash = await bcrypt.hash(password, 12);

    await db.prepare(
      'INSERT INTO users (id, username, email, password_hash, alias, created_at) VALUES (?,?,?,?,?,?)'
    ).run(id, username, email, hash, alias, now);

    const token = jwt.sign({ id, username, alias }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id, username, alias } });

  } catch (err) {
    const isUniqueViolation = 
      err.code === '23505' || // Postgres
      (err.message && /UNIQUE/i.test(err.message)); // SQLite

    if (isUniqueViolation) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  try {
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });

    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);

    const token = jwt.sign(
      { id: user.id, username: user.username, alias: user.alias },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, alias: user.alias } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await db.prepare(
    'SELECT id, username, alias, public_key, created_at, allow_read_receipts FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json(user);
});

// POST /api/auth/settings
router.post('/settings', requireAuth, async (req, res) => {
  const { allow_read_receipts } = req.body;
  const flag = allow_read_receipts ? 1 : 0;
  try {
    await db.prepare('UPDATE users SET allow_read_receipts = ? WHERE id = ?').run(flag, req.user.id);
    res.json({ message: 'Settings updated', allow_read_receipts: flag });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
