#!/usr/bin/env node
"use strict";
/**
 * Manage the encrypted vault.
 *
 * Usage:
 *   node vault-cli.js init                 # create empty vault
 *   node vault-cli.js list                 # list branches (passwords masked)
 *   node vault-cli.js add <id> <name>      # add a branch (prompts password)
 *   node vault-cli.js remove <id>
 *   node vault-cli.js show-password <id>   # reveal one password (caution)
 *   node vault-cli.js import <file.json>   # bulk import from plain JSON
 *   node vault-cli.js export-template      # dump empty schema
 */
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const readline = require("readline");
const { load, save } = require("./vault");

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdin = process.openStdin();
      process.stdin.on("data", (char) => {
        char = char + "";
        if (["\n", "\r", "\u0004"].includes(char)) {
          stdin.pause();
        } else {
          process.stdout.clearLine(0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + "*".repeat(rl.line.length));
        }
      });
    }
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

function mask(s) {
  if (!s) return "";
  if (s.length <= 4) return "****";
  return s.slice(0, 2) + "*".repeat(s.length - 4) + s.slice(-2);
}

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case "init": {
      save({ branches: [] });
      console.log("✓ Empty vault created at ../vault.enc");
      break;
    }
    case "list": {
      const v = load();
      if (v.branches.length === 0) return console.log("(empty vault)");
      console.log(`Total: ${v.branches.length} branches\n`);
      for (const b of v.branches) {
        console.log(`  ${b.id}  ${b.name || "(no name)"}`);
        console.log(`    user: ${b.username || "—"}    pass: ${mask(b.password)}`);
      }
      break;
    }
    case "add": {
      const [, , , id, ...nameParts] = process.argv;
      if (!id) return console.error("Usage: vault-cli add <id> <name>");
      const name = nameParts.join(" ") || id;
      const username = await prompt(`Username for ${name}: `);
      const password = await prompt(`Password for ${name}: `, { hidden: true });
      console.log("");
      const v = load();
      const i = v.branches.findIndex((b) => b.id === id);
      const entry = { id, name, username, password };
      if (i >= 0) v.branches[i] = { ...v.branches[i], ...entry };
      else v.branches.push(entry);
      save(v);
      console.log(`✓ ${i >= 0 ? "Updated" : "Added"} ${id} (${name})`);
      break;
    }
    case "remove": {
      const id = process.argv[3];
      if (!id) return console.error("Usage: vault-cli remove <id>");
      const v = load();
      const before = v.branches.length;
      v.branches = v.branches.filter((b) => b.id !== id);
      save(v);
      console.log(`✓ Removed ${before - v.branches.length} entry`);
      break;
    }
    case "show-password": {
      const id = process.argv[3];
      const v = load();
      const b = v.branches.find((x) => x.id === id);
      if (!b) return console.error("Not found");
      console.log(b.password);
      break;
    }
    case "import": {
      const file = process.argv[3];
      if (!file) return console.error("Usage: vault-cli import <file.json>");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(data.branches)) throw new Error("file must have { branches: [...] }");
      save(data);
      console.log(`✓ Imported ${data.branches.length} branches`);
      break;
    }
    case "import-csv": {
      const file = process.argv[3];
      if (!file) return console.error("Usage: vault-cli import-csv <file.csv>");
      const text = fs.readFileSync(file, "utf8");
      const branches = parseCsv(text);
      if (branches.length === 0) throw new Error("no branches found in CSV");
      save({ branches });
      console.log(`✓ Imported ${branches.length} branches from CSV`);
      console.log(`⚠️  ลบไฟล์ ${file} ทันที (มี password plaintext): rm "${file}"`);
      break;
    }
    case "export-template": {
      console.log(
        JSON.stringify(
          {
            branches: [
              { id: "3-XXXXXXXX", name: "สาขา1", username: "user1", password: "pass1" },
              { id: "3-YYYYYYYY", name: "สาขา2", username: "user2", password: "pass2" },
            ],
          },
          null,
          2,
        ),
      );
      break;
    }
    default:
      console.log(`Usage:
  vault-cli init                         # create empty vault
  vault-cli list                         # list branches (masked)
  vault-cli add <id> <name>              # add/update one branch
  vault-cli remove <id>
  vault-cli show-password <id>           # reveal one password
  vault-cli import <file.json>           # bulk import JSON (then DELETE the plaintext file!)
  vault-cli import-csv <file.csv>        # bulk import CSV (id,name,username,password)
  vault-cli export-template              # show schema for bulk import`);
  }
}

/**
 * Minimal CSV parser supporting RFC-4180 style quoting.
 * Header row required: id,name,username,password
 */
function parseCsv(text) {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((s) => s.trim().toLowerCase());
  const required = ["id", "name", "username", "password"];
  for (const r of required) {
    if (!header.includes(r)) throw new Error(`CSV header missing required column: ${r}`);
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const row = {};
    header.forEach((h, idx) => (row[h] = fields[idx] ?? ""));
    if (!row.id || !row.username || !row.password) continue;
    if (/example|XXXXXXX|YYYYYYY/i.test(row.id)) continue; // skip template rows
    out.push({ id: row.id, name: row.name || row.id, username: row.username, password: row.password });
  }
  return out;
}

function splitCsvLines(text) {
  // Split on newlines but ignore newlines inside quoted fields
  const lines = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (cur || lines.length > 0) lines.push(cur);
      cur = "";
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      cur += c;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

module.exports = { parseCsv };
