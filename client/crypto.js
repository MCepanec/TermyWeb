// E2E encryption using WebCrypto API
// X25519 ECDH + AES-256-GCM (same scheme as C++ version)
// Exported as window.Crypto for use by other modules

const ECDH_PARAMS  = { name: 'ECDH', namedCurve: 'P-256' };
const AES_PARAMS   = { name: 'AES-GCM', length: 256 };
const KEY_STORE    = 'securechat_identity';

// ── Key persistence ────────────────────────────────────
async function loadOrCreateIdentity() {
  const stored = localStorage.getItem(KEY_STORE);
  if (stored) {
    const { pub, priv } = JSON.parse(stored);
    const publicKey  = await importPublicKey(pub);
    const privateKey = await importPrivateKey(priv);
    return { publicKey, privateKey, pub };
  }
  const pair = await crypto.subtle.generateKey(
    ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
  const pub  = await exportPublicKey(pair.publicKey);
  const priv = await exportPrivateKey(pair.privateKey);
  localStorage.setItem(KEY_STORE,
    JSON.stringify({ pub, priv }));
  return { publicKey: pair.publicKey,
           privateKey: pair.privateKey, pub };
}

// ── Key export/import ──────────────────────────────────
async function exportPublicKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function exportPrivateKey(key) {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return JSON.stringify(jwk);
}

async function importPublicKey(b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', raw, ECDH_PARAMS, true, []);
}

async function importPrivateKey(jwkStr) {
  const jwk = JSON.parse(jwkStr);
  return crypto.subtle.importKey(
    'jwk', jwk, ECDH_PARAMS, true,
    ['deriveKey', 'deriveBits']);
}

// ── ECDH shared secret ─────────────────────────────────
async function deriveSharedKey(privateKey, publicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  );
}

// ── Encrypt ────────────────────────────────────────────
// Generates ephemeral keypair, derives shared key with
// recipient pub key, encrypts with AES-GCM
async function encrypt(plaintext, recipientPubB64) {
  const recipientPub = await importPublicKey(recipientPubB64);
  const ephemeral = await crypto.subtle.generateKey(
    ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
  const sharedKey = await deriveSharedKey(
    ephemeral.privateKey, recipientPub);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const enc   = new TextEncoder();
  const ct    = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    sharedKey,
    enc.encode(plaintext)
  );
  const ephPub = await exportPublicKey(ephemeral.publicKey);
  return {
    ciphertext:   arrayToB64(new Uint8Array(ct)),
    nonce:        arrayToB64(nonce),
    ephemeralPub: ephPub
  };
}

// ── Decrypt ────────────────────────────────────────────
async function decrypt(ciphertext, nonce,
                        ephemeralPub, privateKey) {
  const ephPubKey = await importPublicKey(ephemeralPub);
  const sharedKey = await deriveSharedKey(
    privateKey, ephPubKey);
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToArray(nonce) },
    sharedKey,
    b64ToArray(ciphertext)
  );
  return new TextDecoder().decode(dec);
}

// ── AES-GCM for file chunks ────────────────────────────
async function generateFileKey() {
  return crypto.subtle.generateKey(
    AES_PARAMS, true, ['encrypt', 'decrypt']);
}

async function exportFileKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayToB64(new Uint8Array(raw));
}

async function importFileKey(b64) {
  return crypto.subtle.importKey(
    'raw', b64ToArray(b64), AES_PARAMS,
    false, ['encrypt', 'decrypt']);
}

async function encryptChunk(data, key) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, data);
  return {
    data:  arrayToB64(new Uint8Array(ct)),
    nonce: arrayToB64(nonce)
  };
}

async function decryptChunk(dataB64, nonceB64, key) {
  const ct = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToArray(nonceB64) },
    key,
    b64ToArray(dataB64)
  );
  return new Uint8Array(ct);
}

// ── Helpers ────────────────────────────────────────────
function arrayToB64(arr) {
  return btoa(String.fromCharCode(...arr));
}

function b64ToArray(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

window.SC = window.SC || {};
window.SC.crypto = {
  loadOrCreateIdentity,
  encrypt, decrypt,
  importPublicKey, exportPublicKey,
  generateFileKey, exportFileKey, importFileKey,
  encryptChunk, decryptChunk,
  arrayToB64, b64ToArray
};