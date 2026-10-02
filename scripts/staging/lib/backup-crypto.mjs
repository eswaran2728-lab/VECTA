import crypto from "node:crypto";
import zlib from "node:zlib";

const FORMAT_MAGIC = "vecta-encrypted-backup-v1";
const ALGORITHM = "aes-256-gcm";
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/**
 * Encrypts arbitrary serializable backup payload with AES-256-GCM.
 *
 * @param {object} payload - JavaScript object containing backup data
 * @param {string} passphrase - Encryption secret (never logged or stored)
 * @returns {object} Encrypted envelope containing metadata and base64 ciphertext
 */
export function encryptBackupPayload(payload, passphrase) {
  if (!passphrase || typeof passphrase !== "string" || passphrase.length < 8) {
    throw new Error("Passphrase must be a string with at least 8 characters");
  }

  const jsonStr = JSON.stringify(payload);
  const compressed = zlib.gzipSync(Buffer.from(jsonStr, "utf8"));

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);

  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: FORMAT_MAGIC,
    algorithm: ALGORITHM,
    kdf: "scrypt",
    kdfParams: SCRYPT_PARAMS,
    createdAt: new Date().toISOString(),
    saltHex: salt.toString("hex"),
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    ciphertextBase64: ciphertext.toString("base64"),
  };
}

/**
 * Decrypts an encrypted backup envelope using AES-256-GCM and verifies authenticity.
 *
 * @param {object|string} envelopeInput - JSON object or string of envelope
 * @param {string} passphrase - Decryption secret
 * @returns {object} Original decrypted payload object
 */
export function decryptBackupPayload(envelopeInput, passphrase) {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("Decryption passphrase must be provided");
  }

  const envelope = typeof envelopeInput === "string" ? JSON.parse(envelopeInput) : envelopeInput;

  if (envelope.format !== FORMAT_MAGIC) {
    throw new Error(`Unsupported backup envelope format: ${envelope.format}`);
  }
  if (envelope.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported cipher algorithm: ${envelope.algorithm}`);
  }

  const salt = Buffer.from(envelope.saltHex, "hex");
  const iv = Buffer.from(envelope.ivHex, "hex");
  const authTag = Buffer.from(envelope.authTagHex, "hex");
  const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");

  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, envelope.kdfParams || SCRYPT_PARAMS);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decryptedCompressed;
  try {
    decryptedCompressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error("Decryption failed: invalid passphrase or corrupted/tampered backup");
  }

  const decompressed = zlib.gunzipSync(decryptedCompressed);
  return JSON.parse(decompressed.toString("utf8"));
}
