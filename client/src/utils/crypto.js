/**
 * PhantomMail — Client-side encryption
 *
 * Uses the browser's built-in WebCrypto API.
 * Your private key NEVER leaves your browser.
 *
 * Algorithm: RSA-OAEP (2048-bit) + AES-GCM (256-bit) hybrid encryption
 *   - AES-GCM encrypts the actual message (fast, unlimited size)
 *   - RSA-OAEP encrypts the AES key (so only the recipient can unlock it)
 */

// Generate a fresh RSA key pair for a new user
export async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );

  const publicKeyRaw  = await crypto.subtle.exportKey('spki',  keyPair.publicKey);
  const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKey:  ab2b64(publicKeyRaw),
    privateKey: ab2b64(privateKeyRaw),
  };
}

// Encrypt a plaintext string with the recipient's public key (base64)
export async function encryptMessage(plaintext, recipientPubKeyB64) {
  const pubKey = await importPublicKey(recipientPubKeyB64);

  // 1. Generate a random one-time AES key
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // 2. Encrypt the message with AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBody = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext)
  );

  // 3. Encrypt the AES key with the recipient's RSA public key
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    pubKey,
    rawAesKey
  );

  // Bundle into a single JSON string to store on server
  return JSON.stringify({
    encryptedKey: ab2b64(encryptedKey),
    iv:           ab2b64(iv),
    body:         ab2b64(encryptedBody),
  });
}

// Decrypt a message using your private key (base64)
export async function decryptMessage(encryptedJson, privateKeyB64) {
  const { encryptedKey, iv, body } = JSON.parse(encryptedJson);
  const privKey = await importPrivateKey(privateKeyB64);

  // 1. Decrypt the AES key with our private RSA key
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privKey,
    b642ab(encryptedKey)
  );

  // 2. Import the AES key
  const aesKey = await crypto.subtle.importKey(
    'raw', rawAesKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // 3. Decrypt the message
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b642ab(iv) },
    aesKey,
    b642ab(body)
  );

  return new TextDecoder().decode(decrypted);
}

// Save/load private key from localStorage
export const savePrivateKey = (key) => localStorage.setItem('pm_private_key', key);
export const loadPrivateKey = ()    => localStorage.getItem('pm_private_key');

// ── Internal helpers ───────────────────────────────────────────

async function importPublicKey(b64) {
  return crypto.subtle.importKey(
    'spki', b642ab(b64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false, ['encrypt']
  );
}

async function importPrivateKey(b64) {
  return crypto.subtle.importKey(
    'pkcs8', b642ab(b64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false, ['decrypt']
  );
}

const ab2b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

function b642ab(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function exportKeystore(privateKeyB64, publicKeyB64, alias, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(privateKeyB64)
  );

  return JSON.stringify({
    alias,
    salt: ab2b64(salt),
    iv: ab2b64(iv),
    ciphertext: ab2b64(encrypted),
    version: 1
  });
}

export async function importKeystore(backupJson, passphrase) {
  try {
    const backup = JSON.parse(backupJson);
    const salt = b642ab(backup.salt);
    const iv = b642ab(backup.iv);
    const ciphertext = b642ab(backup.ciphertext);

    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error('Keystore import error:', err);
    throw new Error('Wrong passphrase or corrupted backup file.', { cause: err });
  }
}
