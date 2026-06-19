/**
 * Database using 'sqlite3' — pure JavaScript, no C++ compilation on Windows.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const _db = new sqlite3.Database(path.join(__dirname, '../../phantommail.db'));

// Promisified helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((res, rej) => _db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
}
function all(sql, params = []) {
  return new Promise((res, rej) => _db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
}

// Mimic better-sqlite3's db.prepare(sql).run/get/all interface
// but return Promises so route handlers must use await
const db = {
  prepare: (sql) => ({
    run:  (...p) => run(sql, p),
    get:  (...p) => get(sql, p),
    all:  (...p) => all(sql, p),
  }),
};

async function initDB() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    alias         TEXT UNIQUE NOT NULL,
    public_key    TEXT,
    created_at    INTEGER NOT NULL,
    last_seen     INTEGER,
    allow_read_receipts INTEGER DEFAULT 1
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id                TEXT PRIMARY KEY,
    recipient_alias   TEXT NOT NULL,
    sender_alias      TEXT NOT NULL,
    subject_encrypted TEXT NOT NULL,
    body_encrypted    TEXT NOT NULL,
    routing_hops      INTEGER DEFAULT 3,
    approximate_time  INTEGER NOT NULL,
    is_read           INTEGER DEFAULT 0,
    is_ephemeral      INTEGER DEFAULT 0,
    expires_at        INTEGER,
    created_at        INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS key_store (
    alias      TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // Migration: Add allow_read_receipts to users table if it doesn't exist
  try {
    await run('ALTER TABLE users ADD COLUMN allow_read_receipts INTEGER DEFAULT 1');
  } catch (err) {
    // Ignore error if column already exists
  }

  console.log('✓ Database ready');
}

module.exports = { db, initDB };
