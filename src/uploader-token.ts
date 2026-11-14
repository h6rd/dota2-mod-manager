/* The upload token a release build carries, so its owner can send mods without creating a key.
 * Written into src/cache/state.bin by tools/uploader-token.mjs from the repository secret
 * UPLOADER_APP_TOKEN; absent in a source checkout. The name says nothing about the token, so it
 * does not stand out in an unpacked app.
 *
 * The token is encrypted so it does not show up in `strings` or a plain grep of the packaged app.
 * The key travels inside the app too, so this is a speed bump, not a secret: anybody determined
 * enough to unpack the asar and read this file can decrypt it. Revoking it means a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Where the build tool writes the token, beside this module so electron-builder packs it. */
export const EMBEDDED_TOKEN_FILE = path.join(import.meta.dirname, 'cache', 'state.bin');

const MAGIC = Buffer.from('D2MMUP01');
const IV_BYTES = 12;
const TAG_BYTES = 16;
// tools/uploader-token.mjs builds the same key; test/uploader-token.test.ts checks that it does.
const KEY = createHash('sha256').update(['d2pfx-uploader-token', 'v1', 'dota2-mod-manager'].join('\0')).digest();

/** The token in the file's format: magic, IV, authentication tag and the encrypted bytes. */
export function encodeEmbeddedToken(token: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

/** The token out of that format, or null when the file is missing, truncated or tampered with. */
export function decodeEmbeddedToken(raw: Buffer): string | null {
  if (raw.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  try {
    const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = raw.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(raw.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8').trim();
    return token || null;
  } catch { return null; }
}

/** The token built into this copy of the app, or null for a source checkout or a fork's build. */
export function embeddedUploadToken(): string | null {
  try { return decodeEmbeddedToken(fs.readFileSync(EMBEDDED_TOKEN_FILE)); } catch { return null; }
}
