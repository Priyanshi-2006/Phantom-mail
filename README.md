# PhantomMail 🔒

![PhantomMail](https://img.shields.io/badge/Status-Live-success) ![License](https://img.shields.io/badge/License-MIT-blue)

A metadata-minimized, end-to-end encrypted messaging platform designed for absolute privacy.

**Live Demo:** [https://phantom-mail-sage.vercel.app](https://phantom-mail-sage.vercel.app)

---

## 🛡️ Core Features & Privacy Guarantees

PhantomMail doesn't just promise privacy; it mathematically enforces it through architecture.

| Feature | How it works |
|---|---|
| **E2E Encryption** | WebCrypto API (RSA-OAEP 2048 + AES-256-GCM). The browser encrypts all subjects and bodies before they ever touch the network. |
| **Zero-Knowledge Server** | The backend only handles and routes opaque ciphertext blobs. It cannot read your messages. |
| **Alias System** | No real emails or phone numbers. Users are assigned random burner aliases (e.g., `ghost-7f3a2b`). |
| **Metadata Obfuscation** | The server adds ±2 hours of random noise to message timestamps to prevent correlation attacks. |
| **No IP Logging** | The Express server is explicitly configured to discard and never log sender IP addresses. |
| **Ephemeral Messages** | Senders can set a Time-To-Live (TTL). Messages self-destruct from the server automatically once the time expires. |
| **Encrypted Keystore** | Private keys never leave the browser plaintext. Users can backup/restore keys using AES-GCM encryption derived from a PBKDF2 passphrase. |
| **Private Read Receipts** | Optional, opt-in read receipts powered by secure SQL `LEFT JOIN`s ensuring recipient privacy. |

---

## 🚀 Tech Stack

- **Frontend:** React, Vite, Tailwind-inspired Vanilla CSS
- **Backend:** Node.js, Express.js, Socket.io (Real-time updates)
- **Database:** SQLite (Local Dev) / PostgreSQL (Production)
- **Security:** WebCrypto API, bcryptjs, express-rate-limit, jsonwebtoken
- **Deployment:** Vercel (Frontend), Render + Neon (Backend & DB)

---

## 💻 Local Development Setup

To run PhantomMail locally, you'll need Node.js installed. The local environment uses SQLite by default, so no external database setup is required.

### 1. Start the Backend

```bash
cd server
npm install
npm run dev
```
*The server runs on http://localhost:3001*

### 2. Start the Frontend

Open a second terminal window:

```bash
cd client
npm install
npm run dev
```
*The app runs on http://localhost:5173*

---

## 🕵️‍♂️ How to test E2E Encryption locally

1. Open `http://localhost:5173` in **Chrome** — register as User A.
2. Copy User A's alias from the top navigation bar.
3. Open `http://localhost:5173` in **Firefox** (or an Incognito window) — register as User B.
4. As User B, click **Compose** → paste User A's alias → write a message → set a TTL (optional) → Send.
5. Switch back to User A. Thanks to WebSockets, the encrypted message will appear instantly and decrypt entirely inside the browser!

---

## 📂 Architecture Overview

```text
phantommail/
  server/
    src/
      db/database.js        — Smart Adapter: SQLite (Local) / PostgreSQL (Prod)
      middleware/auth.js    — JWT verification
      routes/auth.js        — Authentication & Settings
      routes/messages.js    — Message routing, TTL expiration, Rate limiting
      routes/keys.js        — Public key distribution
      index.js              — Express & Socket.io Entry
  client/
    src/
      utils/api.js          — Axios instances with interceptors
      utils/crypto.js       — WebCrypto logic (RSA/AES/PBKDF2)
      utils/socket.js       — Real-time WebSocket connection handling
      pages/                — React UI Views
```
