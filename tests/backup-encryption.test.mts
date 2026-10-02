import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { encryptBackupPayload, decryptBackupPayload } from "../scripts/staging/lib/backup-crypto.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("backup crypto: AES-256-GCM encryption, decryption, and authentication", () => {
  const sampleBackup = {
    projectRef: "ddlctzbnqewubltcavkh",
    exportedAt: new Date().toISOString(),
    authUsers: [
      { id: "usr-001", email: "secadmin@vecta.test", created_at: "2026-09-01T00:00:00Z", user_metadata: { department: "AVSEC" } },
      { id: "usr-002", email: "officer@vecta.test", created_at: "2026-09-02T00:00:00Z", user_metadata: { station: "KUL" } }
    ],
    data: {
      profiles: [
        { id: "usr-001", name: "Security Admin", staff_no: "VEC001", role: "admin", status: "approved" },
        { id: "usr-002", name: "Security Officer", staff_no: "VEC002", role: "officer", status: "approved" }
      ],
      stations: [
        { code: "KUL", name: "Kuala Lumpur International" }
      ]
    },
    storage: [
      { bucket: "announcements", object: "memo.pdf", size: 1024, base64Bytes: Buffer.from("mock-pdf-bytes").toString("base64") }
    ]
  };

  const passphrase = "super-secret-local-staging-passphrase-2026";

  // 1. Encrypt payload
  const envelope = encryptBackupPayload(sampleBackup, passphrase);

  assert.equal(envelope.format, "vecta-encrypted-backup-v1");
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.kdf, "scrypt");
  assert.ok(envelope.saltHex && envelope.saltHex.length === 32, "16-byte salt as hex");
  assert.ok(envelope.ivHex && envelope.ivHex.length === 24, "12-byte IV as hex");
  assert.ok(envelope.authTagHex && envelope.authTagHex.length === 32, "16-byte auth tag as hex");
  assert.ok(envelope.ciphertextBase64 && envelope.ciphertextBase64.length > 0);

  // 2. Decrypt with correct passphrase
  const decrypted = decryptBackupPayload(envelope, passphrase);
  assert.deepEqual(decrypted, sampleBackup, "Decrypted content matches original payload exactly");

  // 3. Decrypt with wrong passphrase fails
  assert.throws(
    () => decryptBackupPayload(envelope, "wrong-passphrase"),
    /Decryption failed: invalid passphrase or corrupted\/tampered backup/
  );

  // 4. Tampering with ciphertext fails GCM authentication
  const tamperedCiphertext = {
    ...envelope,
    ciphertextBase64: Buffer.from("tampered data stream that is invalid").toString("base64")
  };
  assert.throws(
    () => decryptBackupPayload(tamperedCiphertext, passphrase),
    /Decryption failed: invalid passphrase or corrupted\/tampered backup/
  );

  // 5. Tampering with auth tag fails GCM authentication
  const tamperedTag = {
    ...envelope,
    authTagHex: "00000000000000000000000000000000"
  };
  assert.throws(
    () => decryptBackupPayload(tamperedTag, passphrase),
    /Decryption failed: invalid passphrase or corrupted\/tampered backup/
  );
});

test("backup crypto: round-trip file persistence and restore verification", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vecta-backup-test-"));
  try {
    const samplePayload = {
      projectRef: "ddlctzbnqewubltcavkh",
      exportedAt: "2026-10-02T12:00:00Z",
      authUsers: [{ id: "u-1", email: "sensitive@company.org" }],
      data: { profiles: [{ id: "u-1", name: "Sensitive User" }] }
    };
    const secret = "test-encryption-passphrase-998877";

    const envelope = encryptBackupPayload(samplePayload, secret);
    const encFile = path.join(tmpDir, "backup.enc.json");
    fs.writeFileSync(encFile, JSON.stringify(envelope, null, 2), { mode: 0o600 });

    // Ensure written file does not contain raw email or plain text
    const rawFileContent = fs.readFileSync(encFile, "utf8");
    assert.ok(!rawFileContent.includes("sensitive@company.org"), "Plaintext email must not appear in encrypted file");
    assert.ok(!rawFileContent.includes("Sensitive User"), "Plaintext user name must not appear in encrypted file");

    // Read back and decrypt
    const readEnvelope = JSON.parse(rawFileContent);
    const restored = decryptBackupPayload(readEnvelope, secret);
    assert.deepEqual(restored, samplePayload);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("backup crypto: restore-backup.mjs CLI execution and extraction", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vecta-restore-cli-test-"));
  try {
    const samplePayload = {
      projectRef: "ddlctzbnqewubltcavkh",
      exportedAt: "2026-10-02T12:00:00Z",
      authUsers: [{ id: "u-cli-1", email: "cli-user@company.org" }],
      data: {
        profiles: [{ id: "u-cli-1", name: "CLI User" }],
        stations: [{ code: "KUL", name: "Kuala Lumpur" }]
      }
    };
    const secret = "cli-test-passphrase-123456";
    const envelope = encryptBackupPayload(samplePayload, secret);
    const encFile = path.join(tmpDir, "sample.enc.json");
    fs.writeFileSync(encFile, JSON.stringify(envelope, null, 2), { mode: 0o600 });

    const extractDir = path.join(tmpDir, "extracted");

    // Execute restore-backup.mjs with --extract-to
    const scriptPath = path.join(REPO_ROOT, "scripts", "staging", "restore-backup.mjs");
    const output = child_process.execFileSync(
      process.execPath,
      [scriptPath, `--file=${encFile}`, `--extract-to=${extractDir}`],
      {
        env: { ...process.env, VECTA_BACKUP_PASSPHRASE: secret },
        encoding: "utf8"
      }
    );

    assert.ok(output.includes("Verification SUCCESSFUL: Backup is authentic, intact, and decrypted."));
    assert.ok(output.includes("profiles"));
    assert.ok(output.includes("stations"));

    // Verify extracted files exist
    assert.ok(fs.existsSync(path.join(extractDir, "data", "profiles.json")));
    assert.ok(fs.existsSync(path.join(extractDir, "data", "stations.json")));
    assert.ok(fs.existsSync(path.join(extractDir, "auth-users-inventory.json")));

    const extractedProfiles = JSON.parse(fs.readFileSync(path.join(extractDir, "data", "profiles.json"), "utf8"));
    assert.equal(extractedProfiles[0].name, "CLI User");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
