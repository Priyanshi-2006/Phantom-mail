const express = require('express');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/keys/upload
router.post('/upload', requireAuth, async (req, res) => {
  const { public_key } = req.body;
  if (!public_key) return res.status(400).json({ error: 'public_key required' });
  try {
    const now = Date.now();
    await db.prepare(`
      INSERT INTO key_store (alias, public_key, updated_at) VALUES (?,?,?)
      ON CONFLICT(alias) DO UPDATE SET public_key=excluded.public_key, updated_at=excluded.updated_at
    `).run(req.user.alias, public_key, now);
    await db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(public_key, req.user.id);
    res.json({ message: 'Public key uploaded' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/keys/resolve/:alias  — MUST be before /:alias
router.get('/resolve/:alias', async (req, res) => {
  try {
    const user = await db.prepare('SELECT alias FROM users WHERE alias = ?').get(req.params.alias);
    res.json({ exists: !!user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/keys/presence/:alias — MUST be before /:alias
router.get('/presence/:alias', async (req, res) => {
  try {
    const user = await db.prepare('SELECT last_seen FROM users WHERE alias = ?').get(req.params.alias);
    if (!user) return res.status(404).json({ error: 'Alias not found' });

    const io = req.app.get('io');
    let online = false;
    if (io) {
      const room = io.sockets.adapter.rooms.get(req.params.alias);
      online = room ? room.size > 0 : false;
    }

    res.json({
      alias: req.params.alias,
      online,
      last_seen: user.last_seen
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/keys/:alias
router.get('/:alias', async (req, res) => {
  try {
    const key = await db.prepare('SELECT public_key, updated_at FROM key_store WHERE alias = ?').get(req.params.alias);
    if (!key) return res.status(404).json({ error: 'No public key for this alias' });

    const io = req.app.get('io');
    let online = false;
    if (io) {
      const room = io.sockets.adapter.rooms.get(req.params.alias);
      online = room ? room.size > 0 : false;
    }

    res.json({
      public_key: key.public_key,
      updated_at: key.updated_at,
      online
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
