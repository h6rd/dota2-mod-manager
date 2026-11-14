#!/usr/bin/env node
/**
 * Gives a release build the catalog uploader's token (src/creator-upload.ts), so sending a mod
 * works without asking its author to create a file first.
 *
 * The token is not a secret in the strong sense, since anybody can unpack a release and find the
 * key that decrypts it, but it must not sit in a public repository where every scraper reads it.
 * So it lives in the repository secret UPLOADER_APP_TOKEN, and release.yml runs this just before
 * electron-builder: it writes src/cache/state.bin, which .gitignore keeps out of git and
 * electron-builder packs with the rest of src/. The name says nothing about the token, so it does
 * not stand out in an unpacked app. The bytes are AES-256-GCM encrypted with the key
 * src/uploader-token.ts derives, so the token is not readable with `strings`.
 *
 * Without the secret (a fork, a local build) the file is removed and the build carries no token:
 * sending from that build is unavailable. That is a warning, not a failure. The token itself is
 * never printed.
 *
 * The key and the file format here must match src/uploader-token.ts; test/uploader-token.test.ts
 * runs this tool and decrypts what it wrote, so a change to one without the other fails.
 *
 *   UPLOADER_APP_TOKEN=... node tools/uploader-token.mjs
 *   ... node tools/uploader-token.mjs --out /tmp/state.bin
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultOut = path.join(here, '..', 'src', 'cache', 'state.bin');
const outAt = process.argv.indexOf('--out');
const out = outAt >= 0 && process.argv[outAt + 1] ? path.resolve(process.argv[outAt + 1]) : defaultOut;
const token = String(process.env.UPLOADER_APP_TOKEN || '').trim();

// must match src/uploader-token.ts
const MAGIC = Buffer.from('D2MMUP01');
const IV_BYTES = 12;
const KEY = crypto.createHash('sha256').update(['d2pfx-uploader-token', 'v1', 'dota2-mod-manager'].join('\0')).digest();

if (!token) {
  fs.rmSync(out, { force: true });
  console.log('::warning::UPLOADER_APP_TOKEN is not set: this build will not carry an upload token');
} else if (!/^[\x21-\x7e]{16,512}$/.test(token)) {
  console.log('::error::UPLOADER_APP_TOKEN does not look like a token (printable, 16 to 512 characters)');
  process.exit(1);
} else {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]));
  console.log(`uploader token written (${token.length} characters, encrypted)`);
}
