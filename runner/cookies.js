"use strict";
/**
 * Encrypted cookie storage per Grab merchant account.
 *
 * File layout: cookies/<account>.enc — same AES-256-GCM scheme as the vault.
 * In-memory shape:
 *   { account, cookies: [{ name, value, domain, path, expires, httpOnly, secure, sameSite }],
 *     savedAt, accountInfo: { merchantGroupId?, displayName? } }
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const COOKIES_DIR = path.resolve(__dirname, "..", "cookies");
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
    throw new Error("VAULT_PASSWORD env not set in runner/.env");
  }
  return pw;
}

function safeAccount(account) {
  return account.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function pathFor(account) {
  return path.join(COOKIES_DIR, `${safeAccount(account)}.enc`);
}

function ensureDir() {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

function save(account, cookies, accountInfo = {}) {
  ensureDir();
  const payload = {
    account,
    cookies,
    accountInfo,
    savedAt: new Date().toISOString(),
  };
  const enc = encrypt(JSON.stringify(payload), getMasterPassword());
  fs.writeFileSync(pathFor(account), enc);
  return pathFor(account);
}

function load(account) {
  const p = pathFor(account);
  if (!fs.existsSync(p)) return null;
  const enc = fs.readFileSync(p, "utf8").trim();
  return JSON.parse(decrypt(enc, getMasterPassword()));
}

function list() {
  ensureDir();
  return fs
    .readdirSync(COOKIES_DIR)
    .filter((f) => f.endsWith(".enc"))
    .map((f) => f.replace(/\.enc$/, ""));
}

function remove(account) {
  const p = pathFor(account);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Build a Cookie request header value from saved cookies.
 * Filters by domain (defaults to merchant.grab.com).
 */
function toCookieHeader(cookies, domain = "merchant.grab.com") {
  return cookies
    .filter((c) => !c.domain || c.domain === domain || c.domain === `.${domain}` || c.domain.endsWith("." + domain) || domain.endsWith(c.domain.replace(/^\./, "")))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

module.exports = { save, load, list, remove, toCookieHeader, encrypt, decrypt, COOKIES_DIR };
