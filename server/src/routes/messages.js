const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function obfuscateTimestamp(t) {
  return Math.floor(t + (Math.random() * 2 - 1) * 2 * 60 * 60 * 1000);
}

// POST /api/messages/send
router.post('/send', requireAuth, async (req, res) => {
  const {
    recipient_alias, subject_encrypted, body_encrypted,
    routing_hops = 3, is_ephemeral = false, ephemeral_hours = 48,
  } = req.body;

  if (!recipient_alias || !subject_encrypted || !body_encrypted)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const recipient = await db.prepare('SELECT alias FROM users WHERE alias = ?').get(recipient_alias);
    if (!recipient) return res.status(404).json({ error: 'Recipient alias not found' });

    const id = uuidv4(), now = Date.now();
    const expiresAt = is_ephemeral ? now + ephemeral_hours * 3600 * 1000 : null;
    const approxTime = obfuscateTimestamp(now);

    await db.prepare(`
      INSERT INTO messages
        (id, recipient_alias, sender_alias, subject_encrypted, body_encrypted,
         routing_hops, approximate_time, is_ephemeral, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, recipient_alias, req.user.alias,
      subject_encrypted, body_encrypted,
      routing_hops, approxTime,
      is_ephemeral ? 1 : 0, expiresAt, now
    );

    // ── Real-time: push a notification to the recipient's room ──
    // We only send metadata (no encrypted body) so the push is safe.
    const io = req.app.get('io');
    if (io) {
      io.to(recipient_alias).emit('new_message', {
        id,
        sender_alias:    req.user.alias,
        routing_hops,
        approximate_time: approxTime,
        is_read:         0,
        is_ephemeral:    is_ephemeral ? 1 : 0,
        expires_at:      expiresAt,
      });
    }

    res.status(201).json({ message: 'Sent', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/inbox
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    await db.prepare('DELETE FROM messages WHERE is_ephemeral = 1 AND expires_at < ?').run(Date.now());
    const msgs = await db.prepare(`
      SELECT id, sender_alias, subject_encrypted, approximate_time,
             is_read, is_ephemeral, expires_at, routing_hops
      FROM messages WHERE recipient_alias = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(req.user.alias);
    res.json(msgs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/sent/list
router.get('/sent/list', requireAuth, async (req, res) => {
  try {
    const msgs = await db.prepare(`
      SELECT id, recipient_alias, subject_encrypted, approximate_time, is_ephemeral, routing_hops
      FROM messages WHERE sender_alias = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.user.alias);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const msg = await db.prepare(
      'SELECT * FROM messages WHERE id = ? AND recipient_alias = ?'
    ).get(req.params.id, req.user.alias);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(req.params.id);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/messages/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const r = await db.prepare(
      'DELETE FROM messages WHERE id = ? AND recipient_alias = ?'
    ).run(req.params.id, req.user.alias);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
