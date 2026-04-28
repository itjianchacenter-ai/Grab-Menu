"use strict";
/**
 * AES-256-GCM encrypted vault for branch credentials.
 * - Master password from env VAULT_PASSWORD
 * - Stores: array of branches { id, name, username, password, ... }
 *
 * File format (base64-encoded):
 *   [16 bytes salt][12 bytes IV][16 bytes auth tag][N bytes ciphertext]
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Auto-load runner/.env so any tool that imports vault.js (including `node -e`) gets VAULT_PASSWORD
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const VAULT_PATH = path.resolve(__dirname, "..", "vault.enc");

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

function decrypt(b64, password) {
  const buf = Buffer.from(b64, "base64");
  const salt = buf.slice(0, SALT_LENGTH);
  const iv = buf.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = buf.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const data = buf.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function getMasterPassword() {
  const pw = process.env.VAULT_PASSWORD;
  if (!pw || pw === "change-me-to-a-long-random-string") {
    throw new Error("VAULT_PASSWORD env not set (or still default). Edit runner/.env first.");
  }
  return pw;
}

function load() {
  if (!fs.existsSync(VAULT_PATH)) return { branches: [] };
  const enc = fs.readFileSync(VAULT_PATH, "utf8").trim();
  if (!enc) return { branches: [] };
  return JSON.parse(decrypt(enc, getMasterPassword()));
}

function save(data) {
  const enc = encrypt(JSON.stringify(data, null, 2), getMasterPassword());
  fs.writeFileSync(VAULT_PATH, enc);
}

module.exports = { load, save, encrypt, decrypt, VAULT_PATH };
