const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const os = require('os');
const path = require('path');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Configure S3 Client if environment variables are present
let s3Client = null;
if (process.env.S3_ENDPOINT && process.env.S3_BUCKET_NAME) {
  let endpoint = process.env.S3_ENDPOINT;
  if (!endpoint.startsWith('http')) endpoint = `https://${endpoint}`;
  
  s3Client = new S3Client({
    endpoint,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    // Required for some S3-compatible APIs like B2 or DigitalOcean
    forcePathStyle: true, 
  });
}

const upload = multer({
  storage: s3Client ? multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    key: (req, file, cb) => cb(null, uuidv4()) // Opaque filename prevents metadata leakage
  }) : multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, uuidv4())
    // NOTE: For local dev only. These temp files are never cleaned up automatically.
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB cap
});

const sendMsgLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  keyGenerator: (req) => String(req.user?.alias || req.ip || 'unknown'),
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message sending limit exceeded. Try again later.' }
});

const router = express.Router();

function obfuscateTimestamp(t) {
  return Math.floor(t + (Math.random() * 2 - 1) * 2 * 60 * 60 * 1000);
}

// POST /api/messages/send
router.post('/send', requireAuth, sendMsgLimiter, upload.array('attachments'), async (req, res) => {
  const {
    recipient_alias, subject_encrypted, body_encrypted,
    routing_hops = 3, is_ephemeral = false, expires_at = null,
  } = req.body;

  if (!recipient_alias || !subject_encrypted || !body_encrypted)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const recipient = await db.prepare('SELECT alias FROM users WHERE alias = ?').get(recipient_alias);
    if (!recipient) return res.status(404).json({ error: 'Recipient alias not found' });

    const id = uuidv4(), now = Date.now();
    const isEphemeralBool = (is_ephemeral === 'true' || is_ephemeral === true);
    const expiresAt = isEphemeralBool ? expires_at : null;
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
      isEphemeralBool ? 1 : 0, expiresAt, now
    );

    // Process attachments
    let attachmentMetadata = [];
    if (req.body.attachment_metadata) {
      try {
        attachmentMetadata = JSON.parse(req.body.attachment_metadata);
      } catch (e) {
        console.warn('Failed to parse attachment metadata');
      }
    }

    if (req.files && req.files.length > 0) {
      const attachStmt = db.prepare(`
        INSERT INTO attachments
          (id, message_id, filename_encrypted, encrypted_key, iv, file_size, storage_path, created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const meta = attachmentMetadata[i] || {};
        const storage_path = file.key || file.filename; // S3 uses 'key', disk uses 'filename'
        
        await attachStmt.run(
          uuidv4(), id,
          meta.filename_encrypted || 'unknown',
          meta.encrypted_key || '',
          meta.iv || '',
          file.size,
          storage_path,
          now
        );
      }
    }

    // ── Real-time: push a notification to the recipient's room ──
    const io = req.app.get('io');
    if (io) {
      io.to(recipient_alias).emit('new_message', {
        id,
        sender_alias:    req.user.alias,
        routing_hops,
        approximate_time: approxTime,
        is_read:         0,
        is_ephemeral:    isEphemeralBool ? 1 : 0,
        expires_at:      expiresAt,
        has_attachments: req.files && req.files.length > 0 ? 1 : 0
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
      SELECT m.id, m.sender_alias, m.subject_encrypted, m.approximate_time,
             m.is_read, m.is_ephemeral, m.expires_at, m.routing_hops,
             CASE WHEN EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) THEN 1 ELSE 0 END as has_attachments
      FROM messages m
      WHERE m.recipient_alias = ?
      ORDER BY m.created_at DESC LIMIT 50
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
      SELECT m.id, m.recipient_alias, m.subject_encrypted, m.approximate_time, m.is_ephemeral, m.routing_hops,
             (CASE WHEN u.allow_read_receipts = 1 THEN m.is_read ELSE 0 END) as is_read,
             CASE WHEN EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) THEN 1 ELSE 0 END as has_attachments
      FROM messages m
      LEFT JOIN users u ON m.recipient_alias = u.alias
      WHERE m.sender_alias = ? 
      ORDER BY m.created_at DESC LIMIT 50
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

    if (msg.is_ephemeral && msg.expires_at && Date.now() > msg.expires_at) {
      await db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
      return res.status(404).json({ error: 'Message expired' });
    }

    const attachments = await db.prepare(
      'SELECT id, filename_encrypted, encrypted_key, iv, file_size FROM attachments WHERE message_id = ?'
    ).all(req.params.id);
    
    msg.attachments = attachments || [];

    await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(req.params.id);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/:id/attachments/:attachmentId/download
router.get('/:id/attachments/:attachmentId/download', requireAuth, async (req, res) => {
  try {
    // 1. Verify user is recipient of the message
    const msg = await db.prepare(
      'SELECT * FROM messages WHERE id = ? AND recipient_alias = ?'
    ).get(req.params.id, req.user.alias);
    
    if (!msg) return res.status(403).json({ error: 'Access denied or message not found' });

    // 2. Get attachment metadata
    const attachment = await db.prepare(
      'SELECT * FROM attachments WHERE id = ? AND message_id = ?'
    ).get(req.params.attachmentId, req.params.id);

    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    // 3. Stream from S3 or serve file from local disk
    if (s3Client && process.env.S3_BUCKET_NAME) {
      const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: attachment.storage_path
      });
      const s3Response = await s3Client.send(command);
      res.setHeader('Content-Type', 'application/octet-stream');
      s3Response.Body.on('error', (err) => {
        console.error('S3 stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      });
      s3Response.Body.pipe(res);
    } else {
      // Local fallback
      const localPath = path.join(os.tmpdir(), attachment.storage_path);
      return res.download(localPath);
    }
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Server error downloading file' });
  }
});

// DELETE /api/messages/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // TODO: ON DELETE CASCADE handles DB row cleanup, but leaves orphaned S3 blobs.
    // Need a future cron job to diff B2 objects against attachments table to delete orphaned files.
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

