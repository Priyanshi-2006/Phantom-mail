# PhantomMail 🔒

A metadata-minimized, end-to-end encrypted messaging platform.

## Privacy Guarantees

| Feature | How it works |
|---|---|
| E2E Encryption | RSA-2048 + AES-256-GCM. Browser encrypts before sending. |
| No plaintext on server | Server only ever stores ciphertext blobs. |
| Timestamp obfuscation | Server adds ±2h random noise to message timestamps. |
| Alias system | Users get random aliases like `ghost-7f3a2b` — no real email exposed. |
| No IP logging | Server never logs sender IPs. |
| Private key stays local | Your private key lives in your browser only. |

---

## Setup (do this once)

### 1. Backend
```
cd server
npm install
npm run dev
```
Server runs on http://localhost:3001

### 2. Frontend (open a second terminal)
```
cd client
npm install
npm run dev
```
App opens at http://localhost:5173

---

## How to test with two users

1. Open http://localhost:5173 in **Chrome** — register as User A
2. Copy User A's alias from the top bar
3. Open http://localhost:5173 in **Firefox** (or incognito) — register as User B
4. In User B, click Compose → paste User A's alias → write a message → send
5. Switch back to User A → click the new message → it decrypts in the browser

---

## File structure

```
phantommail/
  server/
    src/
      db/database.js        — SQLite setup + schema
      middleware/auth.js    — JWT verification
      routes/auth.js        — register, login, /me
      routes/messages.js    — send, inbox, read, delete
      routes/keys.js        — public key upload/lookup
      index.js              — Express app entry
    .env                    — PORT + JWT_SECRET
    package.json

  client/
    src/
      utils/api.js          — Axios with auto JWT headers
      utils/crypto.js       — WebCrypto: keygen, encrypt, decrypt
      context/AuthContext.jsx
      pages/LoginPage.jsx
      pages/InboxPage.jsx
      components/ComposeModal.jsx
      App.jsx
      main.jsx
      index.css
```

---

## Next steps after it's working

- [ ] Real-time updates via WebSocket (socket.io)
- [ ] Message search (client-side, after decryption)
- [ ] Contacts list (store aliases you message often)
- [ ] Tor hidden service (.onion address)
- [ ] Deploy to a VPS (DigitalOcean, Hetzner)
- [ ] Mobile app (React Native)
