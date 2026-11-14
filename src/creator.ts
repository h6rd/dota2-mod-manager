/*
 * The author's drafts (issue #236, step 1): a mod being made for the catalog, kept on the author's
 * disk until it is ready, and then either written out as the archive the catalog's own packer makes
 * (src/creator-premod.ts) for the catalog's maintainer, or sent to the catalog's upload API
 * (src/creator-upload.ts) as the form that API takes.
 *
 * A draft is a folder under userData/creator/<id>/: draft.json and the files it names, copied in so
 * the draft survives the originals being moved. Each style is a look of the mod with its own VPK,
 * picture and up to two circle colours, the way the catalog lists styles.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VPK_SIGNATURE } from './vpk-read.ts';
import { catalogProblems, isWebp, MAX_STYLES, premodArchive } from './creator-premod.ts';
import { t } from './i18n.ts';

/** One look of the mod: its label, its VPK, its picture and its circle colours, by file name inside the draft. */
export interface DraftStyle { label: string; vpk: string | null; picture: string | null; colors: string[] }

/** A mod being made for the catalog. */
export interface Draft {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  hero: string;
  description: string;
  /** how the author is credited: a name the catalog already lists, a new one, or nobody */
  authorMode: 'existing' | 'new' | 'skip';
  author: string;
  authorUrl: string;
  /** an optional second credit: a co-author, a source, or who reworked the mod */
  extraMode: 'none' | 'author' | 'source' | 'modded';
  /** whether that second credit is picked from the catalog's list or written in */
  extraOrigin: 'existing' | 'new';
  extraName: string;
  extraUrl: string;
  /** a YouTube preview, for the categories the catalog takes one for */
  video: string;
  /** the catalog's tag switches: slot, effects, icons, and the rest of TAG_CONFIGS */
  tags: Record<string, boolean>;
  styles: DraftStyle[];
  /** the catalog mod this changes, when it is an update of a published one rather than a new one */
  replaces: { category: string; name: string } | null;
  updatedAt: number;
}

/** What the form may change; the rest is the store's. */
export type DraftFields = Partial<Pick<Draft,
  'name' | 'category' | 'subcategory' | 'hero' | 'description' | 'authorMode' | 'author' | 'authorUrl'
  | 'extraMode' | 'extraOrigin' | 'extraName' | 'extraUrl' | 'video' | 'tags' | 'replaces'>>
  & { styles?: { label: string; colors?: string[] }[] };

const AUTHOR_MODES = ['existing', 'new', 'skip'] as const;
const EXTRA_MODES = ['none', 'author', 'source', 'modded'] as const;

const PICTURE = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const MAX_TEXT = 2000;
const ID = /^[0-9a-f-]{36}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const TAG = /^[a-zA-Z0-9_-]{1,40}$/;
/** The palette the catalog offers for a style's circle, in the order a new style takes them. */
export const STYLE_COLORS = ['#ddd4ff', '#ff8f8f', '#8fd3ff'];

const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const colors = (v: unknown, i: number): string[] => {
  const list = Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 2).map((c) => c.toLowerCase()) : [];
  return list.length ? list : [STYLE_COLORS[i] || STYLE_COLORS[0]];
};
const tagSwitches = (v: unknown): Record<string, boolean> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .filter(([k, on]) => TAG.test(k) && on === true).slice(0, 40)) as Record<string, boolean>;
};

const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : fallback;

/** The drafts under userDataDir/creator, and the archive one of them becomes. */
export function createCreator({ userDataDir }: { userDataDir: string }) {
  const root = path.join(userDataDir, 'creator');
  const folder = (id: string) => {
    if (!ID.test(id)) throw new Error(t('Черновик не найден'));
    return path.join(root, id);
  };
  const file = (id: string) => path.join(folder(id), 'draft.json');

  function read(id: string): Draft {
    try {
      const raw = JSON.parse(fs.readFileSync(file(id), 'utf-8')) as Partial<Draft>;
      // drafts written before the upload form existed have no tags, links or colours
      const styles = (Array.isArray(raw.styles) ? raw.styles : []).slice(0, MAX_STYLES).map((s, i) => ({
        label: text(s?.label, 120),
        vpk: typeof s?.vpk === 'string' ? s.vpk : null,
        picture: typeof s?.picture === 'string' ? s.picture : null,
        colors: colors(s?.colors, i),
      }));
      const author = text(raw.author, 80);
      const authorMode = oneOf(raw.authorMode, AUTHOR_MODES, 'new');
      // drafts from before the author modes keep the name they were typed with, as a new one
      const legacySource = text((raw as { source?: unknown }).source, 2048);
      const extraMode = oneOf(raw.extraMode, EXTRA_MODES, legacySource ? 'source' : 'none');
      return {
        id: String(raw.id), name: text(raw.name), category: text(raw.category, 60), subcategory: text(raw.subcategory, 60),
        hero: text(raw.hero, 60), description: text(raw.description, MAX_TEXT),
        authorMode, author, authorUrl: text(raw.authorUrl, 2048),
        extraMode, extraOrigin: oneOf(raw.extraOrigin, ['existing', 'new'] as const, 'new'),
        extraName: text(raw.extraName ?? legacySource, 2048), extraUrl: text(raw.extraUrl, 2048),
        video: text(raw.video, 2048), tags: tagSwitches(raw.tags), styles,
        replaces: raw.replaces && text(raw.replaces.category, 60) && text(raw.replaces.name, 300)
          ? { category: text(raw.replaces.category, 60), name: text(raw.replaces.name, 300) } : null,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    } catch { throw new Error(t('Черновик не найден')); }
  }
  // two saves in one millisecond still come out in the order they were made
  let last = 0;
  function write(d: Draft): Draft {
    d.updatedAt = last = Math.max(Date.now(), last + 1);
    fs.mkdirSync(folder(d.id), { recursive: true });
    fs.writeFileSync(file(d.id), JSON.stringify(d, null, 2));
    return d;
  }

  /** Every draft, the one touched last first. */
  function list(): Draft[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(root).filter((n) => ID.test(n)); } catch { return []; }
    return ids.flatMap((id) => { try { return [read(id)]; } catch { return []; } }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** A new draft, or the fields of one changed. A style dropped takes its files with it. */
  function save(id: string | null, fields: DraftFields): Draft {
    const d: Draft = id ? read(id) : {
      id: crypto.randomUUID(), name: '', category: '', subcategory: '', hero: '', description: '',
      authorMode: 'new', author: '', authorUrl: '', extraMode: 'none', extraOrigin: 'existing', extraName: '', extraUrl: '',
      video: '', tags: {}, styles: [{ label: '', vpk: null, picture: null, colors: [STYLE_COLORS[0]] }], replaces: null, updatedAt: 0,
    };
    if (fields.name !== undefined) d.name = text(fields.name);
    if (fields.category !== undefined) d.category = text(fields.category, 60);
    if (fields.subcategory !== undefined) d.subcategory = text(fields.subcategory, 60);
    if (fields.hero !== undefined) d.hero = text(fields.hero, 60);
    if (fields.description !== undefined) d.description = text(fields.description, MAX_TEXT);
    if (fields.authorMode !== undefined) d.authorMode = oneOf(fields.authorMode, AUTHOR_MODES, d.authorMode);
    if (fields.author !== undefined) d.author = text(fields.author, 80);
    if (fields.authorUrl !== undefined) d.authorUrl = text(fields.authorUrl, 2048);
    if (fields.extraMode !== undefined) d.extraMode = oneOf(fields.extraMode, EXTRA_MODES, d.extraMode);
    if (fields.extraOrigin !== undefined) d.extraOrigin = oneOf(fields.extraOrigin, ['existing', 'new'] as const, d.extraOrigin);
    if (fields.extraName !== undefined) d.extraName = text(fields.extraName, 2048);
    if (fields.extraUrl !== undefined) d.extraUrl = text(fields.extraUrl, 2048);
    if (fields.video !== undefined) d.video = text(fields.video, 2048);
    if (fields.tags !== undefined) d.tags = tagSwitches(fields.tags);
    if (fields.replaces !== undefined) {
      const r = fields.replaces;
      d.replaces = r && text(r.category, 60) && text(r.name, 300) ? { category: text(r.category, 60), name: text(r.name, 300) } : null;
    }
    if (Array.isArray(fields.styles)) {
      const next = fields.styles.slice(0, MAX_STYLES).map((s, i) => ({
        ...(d.styles[i] || { vpk: null, picture: null }),
        label: text(s?.label, 120),
        colors: colors(s?.colors, i),
      }));
      for (const gone of d.styles.slice(next.length)) dropFiles(d.id, gone);
      d.styles = next.length ? next : [{ label: '', vpk: null, picture: null, colors: [STYLE_COLORS[0]] }];
    }
    return write(d);
  }

  function dropFiles(id: string, s: DraftStyle) {
    for (const f of [s.vpk, s.picture]) if (f) fs.rmSync(path.join(folder(id), f), { force: true });
  }

  /** A style's VPK or picture, copied into the draft from where it is. Refuses anything else. */
  function attach(id: string, style: number, kind: 'vpk' | 'picture', from: string): Draft {
    const d = read(id);
    const s = d.styles[style];
    if (!s) throw new Error(t('Черновик не найден'));
    if (kind === 'vpk') {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(from, 'r');
      try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (head.readUInt32LE(0) !== VPK_SIGNATURE) throw new Error(t('Это не VPK-файл'));
    } else if (!PICTURE.test(from)) throw new Error(t('Картинка должна быть PNG, JPG, WebP, GIF или видео MP4/WebM'));
    const ext = kind === 'vpk' ? '.vpk' : path.extname(from).toLowerCase();
    const name = `${kind}-${style}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    const old = s[kind];
    fs.copyFileSync(from, path.join(folder(id), name));
    if (old) fs.rmSync(path.join(folder(id), old), { force: true });
    s[kind] = name;
    return write(d);
  }

  function remove(id: string): void {
    fs.rmSync(folder(id), { recursive: true, force: true });
  }

  /** What is still missing before the draft can go to the catalog, in words for the author. */
  function missing(d: Draft): string[] {
    const out: string[] = [];
    if (!d.name) out.push(t('название'));
    if (!d.category) out.push(t('категория'));
    if (d.authorMode !== 'skip' && !d.author) out.push(t('автор'));
    d.styles.forEach((s, i) => {
      // one look is the mod itself; with several, each is named
      const which = d.styles.length > 1 ? ` ${s.label || i + 1}` : '';
      if (!s.vpk) out.push(which ? t('VPK стиля{0}', which) : 'VPK');
      if (!s.picture) out.push(which ? t('картинка стиля{0}', which) : t('картинка'));
      if (d.styles.length > 1 && !s.label) out.push(t('название стиля {0}', i + 1));
    });
    return out;
  }

  /**
   * The draft as the archive PreMod makes, for the catalog's maintainer. Each style's preview is the
   * WebP the window drew from its picture at 854x480; a style the window could not draw (a clip, or
   * a picture too big to show) takes its picture as it is when that is a WebP already. Refused while
   * something is missing or the catalog's rules say no.
   */
  function bundle(id: string, previews: (Uint8Array | null)[] = []): { name: string; zip: Buffer } {
    const d = read(id);
    const gaps = [...missing(d), ...catalogProblems(d)];
    if (gaps.length) throw new Error(t('Не хватает: {0}', gaps.join(', ')));
    const styles = d.styles.map((s, i) => {
      const drawn = previews[i];
      const own = fs.readFileSync(path.join(folder(id), s.picture!));
      const preview = isWebp(drawn) ? Buffer.from(drawn!) : isWebp(own) ? own : null;
      if (!preview) throw new Error(t('Каталогу нужна картинка-превью, а не видео: {0}', s.label || d.name));
      return { label: s.label, vpk: fs.readFileSync(path.join(folder(id), s.vpk!)), preview };
    });
    return premodArchive(d, styles);
  }

  /**
   * What the upload API takes: the draft, and each style's VPK and WebP preview as bytes. Backs the
   * same preview check as bundle(): a clip or a picture the window could not draw is refused.
   */
  function uploadBundle(id: string, previews: (Uint8Array | null)[] = []): {
    draft: Draft; styles: { label: string; colors: string[]; vpk: Buffer; preview: Buffer }[];
  } {
    const d = read(id);
    const gaps = [...missing(d), ...catalogProblems(d)];
    if (gaps.length) throw new Error(t('Не хватает: {0}', gaps.join(', ')));
    const styles = d.styles.map((s, i) => {
      const drawn = previews[i];
      const own = fs.readFileSync(path.join(folder(id), s.picture!));
      const preview = isWebp(drawn) ? Buffer.from(drawn!) : isWebp(own) ? own : null;
      if (!preview) throw new Error(t('Каталогу нужна картинка-превью, а не видео: {0}', s.label || d.name));
      return { label: s.label, colors: s.colors, vpk: fs.readFileSync(path.join(folder(id), s.vpk!)), preview };
    });
    return { draft: d, styles };
  }

  // The terms are per installation, as they are per browser on the site.
  const consentFile = path.join(root, 'consent.json');
  function consent(): { accepted: boolean; version: string; at: string | null } {
    try {
      const c = JSON.parse(fs.readFileSync(consentFile, 'utf-8')) as { accepted?: unknown; version?: unknown; at?: unknown };
      return { accepted: c.accepted === true, version: String(c.version || ''), at: typeof c.at === 'string' ? c.at : null };
    } catch { return { accepted: false, version: '', at: null }; }
  }
  function acceptTerms(version = '1', at = new Date().toISOString()) {
    fs.mkdirSync(root, { recursive: true });
    const c = { accepted: true, version, at };
    fs.writeFileSync(consentFile, JSON.stringify(c, null, 2));
    return c;
  }

  return { list, save, attach, remove, missing, bundle, uploadBundle, consent, acceptTerms, folder };
}

/** The store createCreator makes. */
export type Creator = ReturnType<typeof createCreator>;
