/**
 * Database adapter — supports both local SQLite and production PostgreSQL.
 * Uses 'pg' if DATABASE_URL is present, otherwise falls back to 'sqlite3'.
 */
const path = require('path');

let pgPool = null;
let sqliteDb = null;

const isPostgres = !!process.env.DATABASE_URL;

if (isPostgres) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  const sqlite3 = require('sqlite3').verbose();
  sqliteDb = new sqlite3.Database(path.join(__dirname, '../../phantommail.db'));
}

// Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
function adaptQuery(sql, params) {
  if (!isPostgres) return { sql, params };
  
  let i = 1;
  const pgSql = sql.replace(/\?/g, () => `$${i++}`);
  return { sql: pgSql, params };
}

// Promisified helpers
function run(sql, params = []) {
  if (isPostgres) {
    const { sql: pgSql } = adaptQuery(sql, params);
    return pgPool.query(pgSql, params).then(res => ({ changes: res.rowCount }));
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      });
    });
  }
}

function get(sql, params = []) {
  if (isPostgres) {
    const { sql: pgSql } = adaptQuery(sql, params);
    return pgPool.query(pgSql, params).then(res => res.rows[0]);
  } else {
    return new Promise((res, rej) => sqliteDb.get(sql, params, (err, row) => err ? rej(err) : res(row)));
  }
}

function all(sql, params = []) {
  if (isPostgres) {
    const { sql: pgSql } = adaptQuery(sql, params);
    return pgPool.query(pgSql, params).then(res => res.rows);
  } else {
    return new Promise((res, rej) => sqliteDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
  }
}

// Mimic better-sqlite3's db.prepare(sql).run/get/all interface
const db = {
  prepare: (sql) => ({
    run:  (...p) => run(sql, p),
    get:  (...p) => get(sql, p),
    all:  (...p) => all(sql, p),
  }),
};

async function initDB() {
  const bigIntType = isPostgres ? 'BIGINT' : 'INTEGER';
  const smallIntType = isPostgres ? 'SMALLINT' : 'INTEGER';

  await run(`CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    alias         TEXT UNIQUE NOT NULL,
    public_key    TEXT,
    created_at    ${bigIntType} NOT NULL,
    last_seen     ${bigIntType},
    allow_read_receipts ${smallIntType} DEFAULT 1
  )`);

  await run(`CREATE TABLE IF NOT EXISTS messages (
    id                TEXT PRIMARY KEY,
    recipient_alias   TEXT NOT NULL,
    sender_alias      TEXT NOT NULL,
    subject_encrypted TEXT NOT NULL,
    body_encrypted    TEXT NOT NULL,
    routing_hops      ${smallIntType} DEFAULT 3,
    approximate_time  ${bigIntType} NOT NULL,
    is_read           ${smallIntType} DEFAULT 0,
    is_ephemeral      ${smallIntType} DEFAULT 0,
    expires_at        ${bigIntType},
    created_at        ${bigIntType} NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS key_store (
    alias      TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    updated_at ${bigIntType} NOT NULL
  )`);

  // Migration: Add allow_read_receipts to users table if it doesn't exist
  try {
    await run(`ALTER TABLE users ADD COLUMN allow_read_receipts ${smallIntType} DEFAULT 1`);
  } catch (err) {
    // Ignore error if column already exists
  }

  console.log(`✓ Database ready (${isPostgres ? 'PostgreSQL' : 'SQLite'})`);
}

module.exports = { db, initDB };
