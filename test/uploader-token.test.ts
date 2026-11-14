/* The encrypted token a release build carries (src/uploader-token.ts, tools/uploader-token.mjs):
 * it must decrypt to itself, refuse a tampered file, and the build tool must write exactly the
 * format the app reads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { decodeEmbeddedToken, encodeEmbeddedToken } from '../src/uploader-token.ts';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'd2pfx_test_0123456789abcdef';

test('an embedded token decrypts back, and its file holds no readable copy', () => {
  const raw = encodeEmbeddedToken(TOKEN);
  assert.ok(!raw.toString('utf8').includes(TOKEN));
  assert.equal(decodeEmbeddedToken(raw), TOKEN);
  assert.equal(decodeEmbeddedToken(Buffer.from('not a token')), null);
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(decodeEmbeddedToken(tampered), null, 'a changed byte is refused, not read as garbage');
});

test('the build tool writes the format the app reads', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-upload-token-')), 'state.bin');
  execFileSync(process.execPath, ['tools/uploader-token.mjs', '--out', out], {
    cwd: root,
    env: { ...process.env, UPLOADER_APP_TOKEN: TOKEN },
    stdio: 'pipe',
  });
  assert.equal(decodeEmbeddedToken(fs.readFileSync(out)), TOKEN);
});

test('a build without the secret writes nothing to carry forward', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-upload-token-')), 'state.bin');
  fs.writeFileSync(out, 'stale');
  execFileSync(process.execPath, ['tools/uploader-token.mjs', '--out', out], {
    cwd: root,
    env: { ...process.env, UPLOADER_APP_TOKEN: '' },
    stdio: 'pipe',
  });
  assert.equal(fs.existsSync(out), false);
});
