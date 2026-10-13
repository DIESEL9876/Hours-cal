// Audits built Windows installers for licensing secrets and for accidental bundling of owner-only tools.
//
//   node scripts/audit-installers.mjs --hourscal <Hours-Cal setup.exe> [--manager <License Manager setup.exe>]
//                                     [--public-key <license_public_key.txt>]
//
// Requires 7-Zip (`7z`) to unpack the NSIS installers. Exit code 1 on any finding.
//  * Hours-Cal installer: must not contain the License Manager, the owner CLI tool, key/backup/licence files,
//    or any owner-key code markers. With --public-key, reports whether that public key is embedded (enforced build).
//  * License Manager installer: must contain only program files (no key, vault, registry, backup or licence data)
//    and must not contain the Hours-Cal application.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.hourscal && !args.manager) {
  console.error('usage: node scripts/audit-installers.mjs --hourscal <setup.exe> [--manager <setup.exe>] [--public-key <file>]');
  process.exit(2);
}

const findings = [];
const notes = [];

function unpack(installer) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-audit-'));
  execFileSync('7z', ['x', '-y', `-o${dir}`, installer], { stdio: 'pipe' });
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return { dir, files };
}

/** Searches a binary for a marker as UTF-8 and UTF-16LE (Windows resources/strings). */
function contains(buf, marker) {
  return buf.includes(Buffer.from(marker, 'utf8')) || buf.includes(Buffer.from(marker, 'utf16le'));
}

// Code/format markers that exist only in owner-side code (License Manager core and CLI tool).
const OWNER_MARKERS = [
  'HOURS-CAL LICENCE SIGNING KEY - PRIVATE', // CLI private key file header
  'hourscal-signing-key.PRIVATE.txt',
  'hourscal-owner-signing-key', // License Manager vault format
  'hourscal-owner-key-backup', // License Manager backup format
  'protected_key_b64',
  'private_key_b64',
  'Hours-Cal License Manager',
  'il.owner.hourscal.licensemanager',
];
const SECRET_FILE = /\.(hckeybak|hclic|sqlite3?|json)$|PRIVATE|owner-signing-key|owner-profile/i;

function audit(label, installer, check) {
  const { dir, files } = unpack(installer);
  try {
    const rel = files.map((f) => relative(dir, f));
    notes.push(`${label}: ${rel.length} files — ${rel.join(', ')}`);
    check(dir, files, rel);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (args.hourscal) {
  audit('Hours-Cal', args.hourscal, (_dir, files, rel) => {
    rel.forEach((r) => {
      if (/license.?manager|hourscal-license-tool/i.test(r)) findings.push(`Hours-Cal installer contains an owner-only program: ${r}`);
      if (SECRET_FILE.test(r)) findings.push(`Hours-Cal installer contains a key/licence/data file: ${r}`);
    });
    for (const f of files) {
      const buf = readFileSync(f);
      for (const m of OWNER_MARKERS) if (contains(buf, m)) findings.push(`Hours-Cal installer file ${relative(_dir, f)} contains owner-only marker "${m}"`);
    }
    if (args['public-key']) {
      const line = readFileSync(args['public-key'], 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      const exe = files.find((f) => /hours-cal\.exe$/i.test(f));
      const embedded = !!(line && exe && contains(readFileSync(exe), line));
      notes.push(
        !line
          ? 'Hours-Cal: the given public-key file has no key line (licence requirement OFF in builds from it)'
          : `Hours-Cal: public key ${line.slice(0, 12)}… ${embedded ? 'IS embedded (licence enforced)' : 'is NOT embedded in hours-cal.exe'}`,
      );
    }
  });
}

if (args.manager) {
  audit('License Manager', args.manager, (dir, files, rel) => {
    rel.forEach((r) => {
      if (SECRET_FILE.test(r) || /\.(txt|db)$/i.test(r)) findings.push(`License Manager installer contains a data/key file: ${r}`);
      if (/hours-cal\.exe$/i.test(r)) findings.push(`License Manager installer contains the Hours-Cal application: ${r}`);
    });
    for (const f of files) {
      const buf = readFileSync(f);
      // A vault/backup/licence *instance* carries values after these markers; the bare format names are code.
      const text = buf.toString('latin1');
      const data = [
        /"protected_key_b64"\s*:\s*"[A-Za-z0-9+/=]{16,}/,
        /"private_key_b64"\s*:\s*"[A-Za-z0-9+/=]{16,}/,
        /"ciphertext_b64"\s*:\s*"[A-Za-z0-9+/=]{16,}/,
        /-----BEGIN HOURS-CAL LICENSE-----\r?\n[A-Za-z0-9_.-]{20,}/,
      ];
      for (const re of data) if (re.test(text)) findings.push(`License Manager installer file ${relative(dir, f)} contains key/licence data (${re.source.slice(0, 24)}…)`);
    }
  });
}

notes.forEach((n) => console.log('•', n));
if (findings.length) {
  console.error('\nAUDIT FAILED:\n  - ' + findings.join('\n  - '));
  process.exit(1);
}
console.log('\nAudit passed: no owner-only programs or key material found.');
