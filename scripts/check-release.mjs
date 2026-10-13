// Release gate for PUBLIC distribution (not needed for the owner's own pre-release builds).
// Fails unless: the legal contact email is set, and the owner's public key is embedded (licence enforced).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const problems = [];
const cfg = JSON.parse(readFileSync(new URL('../legal/release-config.json', import.meta.url), 'utf8'));
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.contact_email ?? '')) problems.push('legal/release-config.json: contact_email is empty or invalid');
const key = readFileSync(new URL('../src-tauri/keys/license_public_key.txt', import.meta.url), 'utf8');
if (!key.split('\n').some((l) => l.trim() && !l.trim().startsWith('#')))
  problems.push('src-tauri/keys/license_public_key.txt: owner public key not configured (licence requirement would be OFF)');
try {
  execFileSync('cargo', ['run', '-q', '-p', 'hourscal-license-tool', '--', 'check-release'], { stdio: 'pipe' });
} catch (e) {
  problems.push(String(e.stderr ?? e.message).trim());
}
if (problems.length) {
  console.error('NOT release-ready for public distribution:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('Release-ready.');
