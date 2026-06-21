# PhantomMail Development Journal

This document tracks the rationale, architecture decisions, and code changes across all development stages of PhantomMail.

## Stage 1: Foundation & Authentication
**Goal**: Set up a secure, modern stack capable of running locally on SQLite and in production on PostgreSQL (Neon). Establish basic user identities without relying on real-world emails.

*   **Stack**: Node.js + Express (Backend), React + Vite (Frontend), SQLite/Postgres (Database).
*   **User Identity (`users` table)**: Instead of standard email addresses, users generate a pseudo-anonymous `alias` (e.g. `ghost-7f3a2b`). 
*   **Authentication (`server/src/routes/auth.js`)**: 
    *   Bcrypt is used for hashing passwords.
    *   JWTs are used for session management.
    *   **Postgres Compatibility**: The signup route explicitly checks for both SQLite `UNIQUE` errors and Postgres `23505` duplicate key constraint violations to ensure identical behavior across environments.

## Stage 2: Zero-Knowledge End-to-End Encryption
**Goal**: Ensure the server *never* sees the plaintext of any message. The server acts only as a blind relay.

*   **Cryptography (`client/src/utils/crypto.js`)**:
    *   Uses standard Web Crypto API.
    *   **RSA-OAEP**: Each user generates a public/private key pair on signup. The public key is sent to the server; the private key never leaves the browser's `localStorage`.
    *   **AES-GCM**: Message bodies are encrypted in the browser. The sender fetches the recipient's public key from the server, encrypts the message, and sends only the ciphertext.
*   **Database (`messages` table)**: Stores `subject_encrypted` and `body_encrypted` as TEXT.

## Stage 3: Real-Time Privacy Features & Ephemerality
**Goal**: Add modern messaging features (real-time delivery, online status) without compromising privacy. Introduce self-destructing messages.

*   **Real-time via Socket.io (`server/src/index.js`)**:
    *   Users join a socket room matching their `alias`.
    *   The backend emits `new_message` events to the room when a message is inserted.
*   **Online Status Lookup (`server/src/routes/keys.js`)**:
    *   When composing a message, the UI checks if the recipient is currently connected to the WebSocket, showing an online/offline indicator.
*   **Ephemeral Messages (TTL)**:
    *   Added `is_ephemeral` and `expires_at` to the `messages` table. 
    *   The inbox route (`GET /api/messages/inbox`) explicitly deletes expired messages before returning the inbox list to ensure they are scrubbed from the database.
*   **Metadata Obfuscation**:
    *   Added `approximate_time` to messages. The server injects ±2 hours of noise into the delivery timestamp to thwart traffic analysis and timing attacks.

## Stage 4: E2E Encrypted Attachments
**Goal**: Allow users to send files securely, overcoming typical server RAM and storage limits.

*   **Storage Architecture (Backblaze B2 & `multer-s3`)**:
    *   Files are streamed directly from the incoming HTTP request to a Backblaze B2 S3 bucket.
    *   **RAM Safety**: Using `multer-s3` ensures large files are chunked and never buffered entirely in the Node server's RAM (critical for Render's 512MB free tier limit).
    *   **Metadata Shielding**: Files are saved to B2 using a random UUID `storage_path` without file extensions. 
*   **Client Encryption (`encryptFile` in `crypto.js`)**:
    *   Since RSA cannot encrypt large amounts of data, the client generates a unique, one-time AES-256 key for each file.
    *   The file is encrypted with AES-GCM.
    *   The AES key is then encrypted with the recipient's RSA public key.
    *   The original filename is also encrypted using the standard message flow.
*   **Database (`attachments` table)**:
    *   Stores the `encrypted_key`, `iv`, `storage_path`, and `filename_encrypted`.
*   **Proxy Download Route (`GET /api/messages/:id/attachments/:attachmentId/download`)**:
    *   Instead of returning a Pre-Signed URL (which causes strict CORS blocks on B2), the backend authorizes the request and pipes the S3 stream directly to the client response.
    *   A `.on('error')` stream handler ensures the connection closes cleanly if B2 blips.
    *   The UI (`InboxPage.jsx`) fetches this stream as a binary Blob, unlocks the AES key using the user's private RSA key, decrypts the file, and triggers a local browser download using `URL.createObjectURL()`.
