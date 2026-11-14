/* The author's drafts (src/creator.ts, issue #236): a draft keeps what the form sends, refuses a file
 * that is not what it says, names what is still missing, and comes out as the archive PreMod makes
 * (src/creator-premod.ts), held to the catalog's upload rules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import { createCreator } from '../src/creator.ts';
import { VPK_SIGNATURE } from '../src/vpk-read.ts';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-creator-'));
  const vpk = path.join(dir, 'glow.vpk');
  const head = Buffer.alloc(12);
  head.writeUInt32LE(VPK_SIGNATURE, 0);
  fs.writeFileSync(vpk, head);
  const png = path.join(dir, 'glow.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'not a vpk');
  return { dir, vpk, png, txt, creator: createCreator({ userDataDir: path.join(dir, 'user') }) };
}

test('a new draft keeps what the form sends, trimmed, and lists first when touched last', () => {
  const { creator } = setup();
  const a = creator.save(null, { name: '  Blue glow  ', author: 'me' });
  assert.equal(a.name, 'Blue glow');
  assert.equal(a.styles.length, 1);
  const b = creator.save(null, { name: 'Second' });
  assert.deepEqual(creator.list().map((d) => d.id), [b.id, a.id]);
  creator.save(a.id, { description: 'x'.repeat(5000) });
  const [first] = creator.list();
  assert.equal(first.id, a.id);
  assert.equal(first.description.length, 2000);
});

test('picking an existing author stays a picked author, even before a name is chosen', () => {
  const { creator } = setup();
  const d = creator.save(null, { name: 'Blue Glow', authorMode: 'existing', author: '' });
  assert.equal(d.authorMode, 'existing');
  const picked = creator.save(d.id, { author: 'Someone' });
  assert.equal(picked.authorMode, 'existing');
  assert.equal(picked.author, 'Someone');
});

test('the upload form keeps the hero, subcategory, tags, links and style colours, and the terms are recorded', () => {
  const { creator } = setup();
  const d = creator.save(null, {
    name: 'Blue Glow', category: 'hero-items', subcategory: 'weapons', hero: 'Anti-Mage',
    authorMode: 'new', author: 'me', authorUrl: 'https://example.com/me',
    extraMode: 'source', extraOrigin: 'new', extraName: 'someone', extraUrl: 'https://example.com/source',
    video: 'https://youtu.be/x', tags: { weapon: true, effects: false },
    styles: [{ label: 'Day', colors: ['#112233', '#445566'] }, { label: 'Night', colors: ['#778899'] }],
  });
  assert.equal(creator.list()[0].hero, 'Anti-Mage');
  assert.equal(creator.list()[0].subcategory, 'weapons');
  assert.equal(creator.list()[0].authorMode, 'new');
  assert.equal(creator.list()[0].extraMode, 'source');
  assert.equal(creator.list()[0].extraOrigin, 'new');
  assert.deepEqual(creator.list()[0].tags, { weapon: true }, 'only the switches that are on are kept');
  assert.deepEqual(creator.list()[0].styles.map((s) => s.colors), [['#112233', '#445566'], ['#778899']]);
  assert.equal(creator.consent().accepted, false);
  assert.equal(creator.acceptTerms('1', '2026-01-01T00:00:00.000Z').accepted, true);
  assert.deepEqual(creator.consent(), { accepted: true, version: '1', at: '2026-01-01T00:00:00.000Z' });
  creator.save(d.id, { tags: { base: true } });
  assert.deepEqual(creator.list()[0].tags, { base: true });
});

test('a file that is not a VPK or a picture is refused, and the draft is unchanged', () => {
  const { creator, txt } = setup();
  const d = creator.save(null, { name: 'x' });
  assert.throws(() => creator.attach(d.id, 0, 'vpk', txt));
  assert.throws(() => creator.attach(d.id, 0, 'picture', txt));
  assert.equal(creator.list()[0].styles[0].vpk, null);
});

test('an id that is not a draft id does not reach outside the drafts folder', () => {
  const { creator } = setup();
  assert.throws(() => creator.remove('../../etc'));
  assert.throws(() => creator.save('../x', {}));
});

test('what is missing is named, and the archive is refused until nothing is', () => {
  const { creator, vpk, png } = setup();
  const d = creator.save(null, {});
  assert.equal(creator.missing(d).length, 5);
  assert.throws(() => creator.bundle(d.id));
  creator.save(d.id, { name: 'Blue glow', category: 'river', author: 'me' });
  creator.attach(d.id, 0, 'vpk', vpk);
  const full = creator.attach(d.id, 0, 'picture', png);
  assert.deepEqual(creator.missing(full), []);
  // a second style asks for its own files and its own name
  const two = creator.save(d.id, { styles: [{ label: '' }, { label: '' }] });
  assert.equal(creator.missing(two).length, 4);
});

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

test('the archive is the one PreMod makes: the VPK zipped, a WebP preview, mod.json and hash.json', () => {
  const { creator, vpk, png } = setup();
  const d = creator.save(null, { name: 'Blue glow', category: 'river', author: 'https://example.com/me', styles: [{ label: 'Day' }, { label: 'Night' }] });
  for (const i of [0, 1]) {
    creator.attach(d.id, i, 'vpk', vpk);
    creator.attach(d.id, i, 'picture', png);
  }
  assert.throws(() => creator.bundle(d.id), /видео|clip/i, 'a PNG the window did not draw is no preview');
  const { name, zip } = creator.bundle(d.id, [WEBP, WEBP]);
  assert.equal(name, 'Blue glow.zip');
  const z = new AdmZip(zip);
  assert.deepEqual(z.getEntries().map((e) => e.entryName).sort(),
    ['Blue glow Night.webp', 'Blue glow Night.zip', 'Blue glow.webp', 'Blue glow.zip', 'hash.json', 'mod.json', 'submit.json']);
  const entry = JSON.parse(z.readAsText('mod.json'));
  assert.equal(entry.name, 'Blue glow');
  assert.equal(entry.file, 'Blue glow.zip');
  assert.equal(entry.preview, 'Blue glow.webp');
  assert.deepEqual(entry.styles.map((s: { label: string }) => s.label), ['Day', 'Night']);
  assert.deepEqual(entry.links, [{ type: 'author', url: 'https://example.com/me' }]);
  const inner = new AdmZip(z.getEntry('Blue glow.zip')!.getData());
  assert.deepEqual(inner.getEntries().map((e) => e.entryName), ['Blue glow.vpk']);
  const hash = JSON.parse(z.readAsText('hash.json'));
  assert.equal(hash.mod_name, 'Blue glow');
  assert.match(hash.vpk_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(z.readAsText('submit.json')), { mode: 'new', category: 'river', hero: null, description: null });
  assert.ok(z.getEntry('Blue glow.webp')!.getData().equals(WEBP));
});

test('the catalog’s rules: a Latin name, the hero in a hero’s mod, three styles at most', () => {
  const { creator, vpk, png } = setup();
  const d = creator.save(null, { name: 'Синий свет', category: 'heroes', hero: 'Anti-Mage', author: 'me' });
  creator.attach(d.id, 0, 'vpk', vpk);
  creator.attach(d.id, 0, 'picture', png);
  assert.throws(() => creator.bundle(d.id, [WEBP]), /латиниц|Latin/i);
  creator.save(d.id, { name: 'Blue Glow' });
  assert.throws(() => creator.bundle(d.id, [WEBP]), /геро|hero/i);
  creator.save(d.id, { name: 'Antimage Blue Glow' });
  assert.equal(creator.bundle(d.id, [WEBP]).name, 'Antimage Blue Glow.zip');
  // the hyphen in a hero's own name is part of the name, not punctuation to strip
  creator.save(d.id, { name: 'Anti-Mage Blue Glow' });
  assert.equal(creator.bundle(d.id, [WEBP]).name, 'Anti-Mage Blue Glow.zip');
  const many = creator.save(d.id, { styles: [1, 2, 3, 4].map((i) => ({ label: `s${i}` })) });
  assert.equal(many.styles.length, 3, 'the form keeps no more styles than the catalog takes');
});

test('a style dropped takes its files with it, and a deleted draft is gone from disk', () => {
  const { creator, vpk } = setup();
  const d = creator.save(null, { styles: [{ label: 'a' }, { label: 'b' }] });
  const withFile = creator.attach(d.id, 1, 'vpk', vpk);
  const file = path.join(creator.folder(d.id), withFile.styles[1].vpk!);
  assert.ok(fs.existsSync(file));
  creator.save(d.id, { styles: [{ label: 'a' }] });
  assert.ok(!fs.existsSync(file));
  creator.remove(d.id);
  assert.deepEqual(creator.list(), []);
});
