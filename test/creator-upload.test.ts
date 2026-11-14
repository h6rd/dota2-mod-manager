/* The hand-off to the catalog's upload API (src/creator-upload.ts): the form the site posts,
 * one zip with one VPK per style, the token it reads, and the worker's answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import { submitMod, uploadForm, uploadStatus, uploadToken, vpkArchive } from '../src/creator-upload.ts';
import type { Draft } from '../src/creator.ts';

const vpk = Buffer.alloc(16);
vpk.writeUInt32LE(0x55aa1234, 0);

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'draft', name: 'Blue Glow', category: 'heroes', subcategory: '', hero: 'Anti-Mage',
  description: 'A glow', authorMode: 'new', author: 'me', authorUrl: '', extraMode: 'none', extraOrigin: 'existing',
  extraName: '', extraUrl: '', video: '', tags: { base: true },
  styles: [{ label: '', vpk: 'a.vpk', picture: 'a.png', colors: ['#ddd4ff'] }], replaces: null, updatedAt: 0, ...over,
});

const style = (label = '', colors = ['#ddd4ff']) => ({ label, colors, vpk, preview: Buffer.from('RIFF....WEBP') });

test('a VPK travels as a zip holding exactly that one .vpk', () => {
  const zip = new AdmZip(vpkArchive('Blue Glow', vpk));
  assert.deepEqual(zip.getEntries().map((e) => e.entryName), ['Blue Glow.vpk']);
  assert.ok(zip.readFile('Blue Glow.vpk')!.equals(vpk));
});

test('the form has the site’s field names, the Hero, the category and the tags', () => {
  const fd = uploadForm(draft(), [style()]);
  assert.equal(fd.get('mode'), 'new');
  assert.equal(fd.get('name'), 'Blue Glow');
  assert.equal(fd.get('category'), 'heroes');
  assert.equal(fd.get('hero'), 'Anti-Mage');
  assert.equal(fd.get('authorMode'), 'new');
  assert.equal(fd.get('authorName'), 'me');
  assert.deepEqual(JSON.parse(String(fd.get('tags'))), { base: true });
  assert.equal(fd.get('styled'), null);
  assert.ok(fd.get('modZip') instanceof Blob);
  assert.ok(fd.get('preview') instanceof Blob);
});

test('two or three styles send styled=1, their names, colours and one zip each', () => {
  const styles = [style('Day', ['#112233', '#445566']), style('Night', ['#778899']), style('Dawn', ['#aabbcc'])];
  const fd = uploadForm(draft(), styles);
  assert.equal(fd.get('styled'), '1');
  assert.deepEqual(JSON.parse(String(fd.get('styles'))), [
    { label: 'Day', colors: ['#112233', '#445566'] },
    { label: 'Night', colors: ['#778899'] },
    { label: 'Dawn', colors: ['#aabbcc'] },
  ]);
  for (const n of ['modZip', 'modZip2', 'modZip3', 'preview', 'preview2', 'preview3']) assert.ok(fd.get(n) instanceof Blob, n);
});

test('an author is picked from the catalog, written in, or left Anonymous', () => {
  const existing = uploadForm(draft({ authorMode: 'existing', author: 'Someone', authorUrl: 'https://ignored.example' }), [style()]);
  assert.equal(existing.get('authorMode'), 'existing');
  assert.equal(existing.get('authorName'), 'Someone');
  assert.equal(existing.get('authorUrl'), null);
  const anonymous = uploadForm(draft({ authorMode: 'skip', author: '' }), [style()]);
  assert.equal(anonymous.get('authorMode'), 'new');
  assert.equal(anonymous.get('authorName'), 'Anonymous');
});

test('the extra link is a listed name or a new one, with its type', () => {
  const listed = uploadForm(draft({ extraMode: 'source', extraOrigin: 'existing', extraName: 'Steam Workshop' }), [style()]);
  assert.equal(listed.get('extraMode'), 'source');
  assert.equal(listed.get('extraExistingName'), 'Steam Workshop');
  assert.equal(listed.get('extraName'), null);
  const written = uploadForm(draft({ extraMode: 'modded', extraOrigin: 'new', extraName: 'Someone', extraUrl: 'https://example.com' }), [style()]);
  assert.equal(written.get('extraMode'), 'modded');
  assert.equal(written.get('extraName'), 'Someone');
  assert.equal(written.get('extraUrl'), 'https://example.com');
  assert.equal(written.get('extraExistingName'), null);
});

test('an update takes the existing name, and refuses styles the worker would refuse', () => {
  const fd = uploadForm(draft({ name: 'Ignored', replaces: { category: 'heroes', name: 'Blue Glow' } }), [style()]);
  assert.equal(fd.get('mode'), 'update');
  assert.equal(fd.get('existingName'), 'Blue Glow');
  assert.equal(fd.get('name'), 'Blue Glow');
  assert.equal(fd.get('authorMode'), null);
  assert.throws(() => uploadForm(draft({ replaces: { category: 'heroes', name: 'Blue Glow' } }), [style('a'), style('b')]), /одним стилем|one style/i);
});

test('the token comes from the build (UPLOADER_APP_TOKEN), and the answer is the pull request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-upload-'));
  assert.equal(uploadToken(null), null, 'no token when embedded is null/empty');
  assert.equal(uploadToken('d2pfx_built_0123456789'), 'd2pfx_built_0123456789', 'build token is used');
  // User token files are no longer read/migrated
  assert.equal(fs.existsSync(path.join(dir, 'uploader-token.txt')), false, 'plain-text token file is not created');
  assert.equal(fs.existsSync(path.join(dir, 'cache', 'state.bin')), false, 'encrypted store is not used');

  let sent: RequestInit | null = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = init || null;
    return new Response(JSON.stringify({ ok: true, id: 'abc', prUrl: 'https://github.com/x/y/pull/1' }), { status: 200 });
  }) as typeof fetch;
  const answer = await submitMod({ draft: draft(), styles: [style()], token: 'd2pfx_x', fetchImpl });
  assert.equal(answer.prUrl, 'https://github.com/x/y/pull/1');
  assert.equal((sent as unknown as { method: string }).method, 'POST');
  assert.equal(((sent as unknown as { headers: Record<string, string> }).headers).Authorization, 'Bearer d2pfx_x');
  assert.ok((sent as unknown as { body: FormData }).body instanceof FormData);
});

test('a worker refusal reaches the author as its own message', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'Wait a bit' }), { status: 429 })) as typeof fetch;
  await assert.rejects(submitMod({ draft: draft(), styles: [style()], token: 'd2pfx_x', fetchImpl }), /Wait a bit/);
});

test('the status call reads the worker’s quota', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ canSubmitNow: false, nextSubmitInSeconds: 30, submissionsUsed: 2, submissionsMax: 3, windowResetInSeconds: 90 }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await uploadStatus({ token: 'd2pfx_x', fetchImpl }), {
    canSubmitNow: false, nextSubmitInSeconds: 30, submissionsUsed: 2, submissionsMax: 3, windowResetInSeconds: 90,
  });
});
