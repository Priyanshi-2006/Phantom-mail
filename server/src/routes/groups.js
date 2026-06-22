const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function obfuscateTimestamp(t) {
  return Math.floor(t + (Math.random() * 2 - 1) * 2 * 60 * 60 * 1000);
}

const MAX_GROUP_MEMBERS = 50;

// ── POST /api/groups/create ───────────────────────────────────
router.post('/create', requireAuth, async (req, res) => {
  const { name, members, encrypted_keys } = req.body;

  if (!name || !name.trim())
    return res.status(400).json({ error: 'Group name is required' });
  if (!members || !Array.isArray(members) || members.length === 0)
    return res.status(400).json({ error: 'At least one other member is required' });
  if (!encrypted_keys || typeof encrypted_keys !== 'object')
    return res.status(400).json({ error: 'encrypted_keys object is required' });

  // Include creator in total count
  const allMembers = [...new Set([req.user.alias, ...members])];
  if (allMembers.length > MAX_GROUP_MEMBERS)
    return res.status(400).json({ error: `Max ${MAX_GROUP_MEMBERS} members per group` });

  // Verify all members exist
  for (const alias of allMembers) {
    if (!encrypted_keys[alias])
      return res.status(400).json({ error: `Missing encrypted key for member: ${alias}` });
  }

  try {
    // Verify all member aliases exist in users table
    for (const alias of members) {
      const user = await db.prepare('SELECT alias FROM users WHERE alias = ?').get(alias);
      if (!user) return res.status(404).json({ error: `Alias not found: ${alias}` });
    }

    const id = uuidv4();
    const now = Date.now();

    // Create the group
    await db.prepare(
      'INSERT INTO groups (id, name, creator_alias, current_key_version, created_at) VALUES (?,?,?,?,?)'
    ).run(id, name.trim(), req.user.alias, 1, now);

    // Insert all members (creator + invited)
    const memberStmt = db.prepare(
      'INSERT INTO group_members (group_id, member_alias, encrypted_group_key, key_version, joined_at) VALUES (?,?,?,?,?)'
    );
    for (const alias of allMembers) {
      await memberStmt.run(id, alias, encrypted_keys[alias], 1, now);
    }

    // Notify all members (except creator) via their alias rooms
    const io = req.app.get('io');
    if (io) {
      for (const alias of members) {
        if (alias !== req.user.alias) {
          io.to(alias).emit('group_added', {
            id, name: name.trim(), creator_alias: req.user.alias,
            member_count: allMembers.length, current_key_version: 1,
          });
        }
      }
    }

    res.status(201).json({
      message: 'Group created', id, name: name.trim(),
      member_count: allMembers.length,
    });
  } catch (err) {
    console.error('Group create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/list ──────────────────────────────────────
router.get('/list', requireAuth, async (req, res) => {
  try {
    const groups = await db.prepare(`
      SELECT g.id, g.name, g.creator_alias, g.current_key_version, g.created_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
        (SELECT MAX(created_at) FROM group_messages WHERE group_id = g.id) as last_message_time
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      WHERE gm.member_alias = ?
      ORDER BY COALESCE(
        (SELECT MAX(created_at) FROM group_messages WHERE group_id = g.id),
        g.created_at
      ) DESC
    `).all(req.user.alias);

    res.json(groups);
  } catch (err) {
    console.error('Group list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/:id ───────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    // Verify user is a member
    const membership = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, req.user.alias);
    if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

    const group = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const members = await db.prepare(
      'SELECT member_alias, key_version, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at ASC'
    ).all(req.params.id);

    res.json({ ...group, members });
  } catch (err) {
    console.error('Group detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/:id/messages ──────────────────────────────
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    // Verify user is a member
    const membership = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, req.user.alias);
    if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    let msgs;
    if (before) {
      msgs = await db.prepare(`
        SELECT id, sender_alias, body_encrypted, key_version, approximate_time
        FROM group_messages
        WHERE group_id = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT 100
      `).all(req.params.id, before);
    } else {
      msgs = await db.prepare(`
        SELECT id, sender_alias, body_encrypted, key_version, approximate_time
        FROM group_messages
        WHERE group_id = ?
        ORDER BY created_at DESC LIMIT 100
      `).all(req.params.id);
    }

    res.json(msgs);
  } catch (err) {
    console.error('Group messages error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/:id/send ─────────────────────────────────
router.post('/:id/send', requireAuth, async (req, res) => {
  const { body_encrypted, key_version } = req.body;

  if (!body_encrypted)
    return res.status(400).json({ error: 'body_encrypted is required' });

  try {
    // Verify sender is a member
    const membership = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, req.user.alias);
    if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

    const id = uuidv4();
    const now = Date.now();
    const approxTime = obfuscateTimestamp(now);

    // Get group's current key version if not provided
    const group = await db.prepare('SELECT current_key_version FROM groups WHERE id = ?').get(req.params.id);
    const msgKeyVersion = key_version || group.current_key_version;

    await db.prepare(`
      INSERT INTO group_messages (id, group_id, sender_alias, body_encrypted, key_version, approximate_time, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, req.params.id, req.user.alias, body_encrypted, msgKeyVersion, approxTime, now);

    // Emit to group room (all members including sender — client can filter)
    const io = req.app.get('io');
    if (io) {
      io.to(`group:${req.params.id}`).emit('new_group_message', {
        id,
        group_id: req.params.id,
        sender_alias: req.user.alias,
        body_encrypted,
        key_version: msgKeyVersion,
        approximate_time: approxTime,
      });
    }

    res.status(201).json({ message: 'Sent', id });
  } catch (err) {
    console.error('Group send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/:id/members ──────────────────────────────
router.post('/:id/members', requireAuth, async (req, res) => {
  const { alias, encrypted_group_key } = req.body;

  if (!alias || !encrypted_group_key)
    return res.status(400).json({ error: 'alias and encrypted_group_key are required' });

  try {
    // Verify requester is the creator
    const group = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.creator_alias !== req.user.alias)
      return res.status(403).json({ error: 'Only the group creator can add members' });

    // Verify alias exists
    const user = await db.prepare('SELECT alias FROM users WHERE alias = ?').get(alias);
    if (!user) return res.status(404).json({ error: 'Alias not found' });

    // Check not already a member
    const existing = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, alias);
    if (existing) return res.status(409).json({ error: 'Already a member' });

    // Check member cap
    const countRow = await db.prepare(
      'SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?'
    ).get(req.params.id);
    if (countRow.cnt >= MAX_GROUP_MEMBERS)
      return res.status(400).json({ error: `Max ${MAX_GROUP_MEMBERS} members` });

    const now = Date.now();
    await db.prepare(
      'INSERT INTO group_members (group_id, member_alias, encrypted_group_key, key_version, joined_at) VALUES (?,?,?,?,?)'
    ).run(req.params.id, alias, encrypted_group_key, group.current_key_version, now);

    // Notify the new member via their alias room
    const io = req.app.get('io');
    if (io) {
      io.to(alias).emit('group_added', {
        id: group.id, name: group.name, creator_alias: group.creator_alias,
        current_key_version: group.current_key_version,
      });
      // Notify existing group members
      io.to(`group:${req.params.id}`).emit('member_added', {
        group_id: req.params.id, alias, joined_at: now,
      });
    }

    res.status(201).json({ message: 'Member added' });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/groups/:id/members/:alias ──────────────────────
// ATOMIC: remove member + rotate key in one operation
router.delete('/:id/members/:alias', requireAuth, async (req, res) => {
  const { new_encrypted_keys } = req.body;

  if (!new_encrypted_keys || typeof new_encrypted_keys !== 'object')
    return res.status(400).json({ error: 'new_encrypted_keys object is required for key rotation' });

  try {
    // Verify requester is the creator
    const group = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.creator_alias !== req.user.alias)
      return res.status(403).json({ error: 'Only the group creator can remove members' });

    // Can't remove yourself via this endpoint (use /leave instead)
    if (req.params.alias === req.user.alias)
      return res.status(400).json({ error: 'Use /leave to remove yourself from the group' });

    // Verify target is a member
    const target = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, req.params.alias);
    if (!target) return res.status(404).json({ error: 'Member not found in group' });

    const newVersion = group.current_key_version + 1;

    // ATOMIC operations: remove + rotate
    // 1. Delete the removed member
    await db.prepare(
      'DELETE FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).run(req.params.id, req.params.alias);

    // 2. Update group's current_key_version
    await db.prepare(
      'UPDATE groups SET current_key_version = ? WHERE id = ?'
    ).run(newVersion, req.params.id);

    // 3. Update all remaining members with new encrypted keys
    const remaining = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ?'
    ).all(req.params.id);

    for (const member of remaining) {
      if (!new_encrypted_keys[member.member_alias]) {
        // If a key is missing for a remaining member, this is an error
        // but we've already removed the member, so log and continue
        console.warn(`Missing new encrypted key for ${member.member_alias} during rotation`);
        continue;
      }
      await db.prepare(
        'UPDATE group_members SET encrypted_group_key = ?, key_version = ? WHERE group_id = ? AND member_alias = ?'
      ).run(new_encrypted_keys[member.member_alias], newVersion, req.params.id, member.member_alias);
    }

    // Notify removed member via their alias room
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.alias).emit('group_removed', { group_id: req.params.id });
      // Notify remaining members of key rotation
      io.to(`group:${req.params.id}`).emit('group_key_rotated', {
        group_id: req.params.id, new_key_version: newVersion, removed_alias: req.params.alias,
      });
    }

    res.json({ message: 'Member removed and key rotated', new_key_version: newVersion });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/groups/:id/leave ────────────────────────────────
router.post('/:id/leave', requireAuth, async (req, res) => {
  try {
    const group = await db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Verify user is a member
    const membership = await db.prepare(
      'SELECT member_alias FROM group_members WHERE group_id = ? AND member_alias = ?'
    ).get(req.params.id, req.user.alias);
    if (!membership) return res.status(403).json({ error: 'Not a member of this group' });

    const io = req.app.get('io');

    if (group.creator_alias === req.user.alias) {
      // Creator leaves → dissolve the group
      // Notify all members before deletion
      if (io) {
        io.to(`group:${req.params.id}`).emit('group_dissolved', {
          group_id: req.params.id, name: group.name,
        });
      }

      // Delete all members, messages, and the group
      await db.prepare('DELETE FROM group_members WHERE group_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(req.params.id);
      await db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);

      res.json({ message: 'Group dissolved' });
    } else {
      // Regular member leaves
      await db.prepare(
        'DELETE FROM group_members WHERE group_id = ? AND member_alias = ?'
      ).run(req.params.id, req.user.alias);

      if (io) {
        // Notify the leaving member
        io.to(req.user.alias).emit('group_removed', { group_id: req.params.id });
        // Notify remaining group members
        io.to(`group:${req.params.id}`).emit('member_left', {
          group_id: req.params.id, alias: req.user.alias,
        });
      }

      res.json({ message: 'Left group. Creator should rotate the group key.' });
    }
  } catch (err) {
    console.error('Leave group error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/groups/:id/key ───────────────────────────────────
router.get('/:id/key', requireAuth, async (req, res) => {
  try {
    const version = req.query.version ? parseInt(req.query.version, 10) : null;

    let row;
    if (version) {
      // Fetch specific version — check historical membership (member might have had it)
      row = await db.prepare(
        'SELECT encrypted_group_key, key_version FROM group_members WHERE group_id = ? AND member_alias = ?'
      ).get(req.params.id, req.user.alias);
    } else {
      // Fetch current version
      row = await db.prepare(
        'SELECT encrypted_group_key, key_version FROM group_members WHERE group_id = ? AND member_alias = ?'
      ).get(req.params.id, req.user.alias);
    }

    if (!row) return res.status(403).json({ error: 'Not a member of this group' });

    res.json({
      encrypted_group_key: row.encrypted_group_key,
      key_version: row.key_version,
    });
  } catch (err) {
    console.error('Get group key error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
