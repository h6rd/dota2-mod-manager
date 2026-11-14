/*
 * Sending a draft to the catalog's upload API (the worker behind
 * h6rd/Dota2PornFxWeb's upload.html). The form is the site's: the same field names, the same
 * rules, and the same shape of files - each style goes as a zip holding one .vpk, beside its
 * 854x480 WebP preview. The desktop app identifies itself with a bearer token, which is what
 * lets the worker skip the browser captcha; the terms are accepted in the app and recorded by
 * the app's own API (src/creator.ts), as the worker treats an app-token submission as consent.
 *
 * Nothing here touches Electron or the disk beyond reading a token file, so the form can be
 * built and checked in plain Node.
 */
import AdmZip from 'adm-zip';
import { t } from './i18n.ts';
import { embeddedUploadToken } from './uploader-token.ts';
import type { Draft } from './creator.ts';

/** The worker the catalog's upload page posts to. */
export const UPLOAD_API = 'https://uploader.hrdq.workers.dev';
/** The terms version the app records when an author accepts them; must match the worker's. */
export const UPLOAD_CONSENT_VERSION = '1';

/** One style as the API takes it: its label, its circle colours, its VPK and WebP preview. */
export interface UploadStyle { label: string; colors: string[]; vpk: Buffer; preview: Buffer }

/** What the worker answers a successful submission with: the catalog id and the pull request it opened. */
export interface UploadReply { ok: true; id: string; prUrl: string }
/** This caller's quota and cooldown, as GET /api/status reports them. */
export interface UploadStatus {
  canSubmitNow: boolean;
  nextSubmitInSeconds: number;
  submissionsUsed: number;
  submissionsMax: number;
  windowResetInSeconds: number;
}

/** A zip holding exactly the one .vpk the upload API unpacks and checks. */
export function vpkArchive(name: string, vpk: Buffer): Buffer {
  const zip = new AdmZip();
  zip.addFile(`${name}.vpk`, vpk);
  return zip.toBuffer();
}

/** A Buffer as a Blob, through a fresh ArrayBuffer: Node's Buffer view may share a larger one. */
function blobOf(b: Buffer): Blob {
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return new Blob([copy]);
}

/** The form the site posts, built from a draft. */
export function uploadForm(draft: Draft, styles: UploadStyle[]): FormData {
  if (!styles.length) throw new Error(t('У мода нет файлов для загрузки'));
  if (draft.replaces && styles.length > 1) throw new Error(t('Обновить мод можно только одним стилем'));
  const fd = new FormData();
  fd.set('mode', draft.replaces ? 'update' : 'new');
  if (draft.replaces) fd.set('existingName', draft.replaces.name);
  // Ensure mod name is valid for the worker: allow only English letters, digits and spaces.
  // When a hero from the predefined list is selected, normalize the name by replacing
  // hyphens with spaces so the worker's MOD_NAME_RE accepts it.
  let name = draft.replaces?.name || draft.name;
  if (draft.hero && /['''-]/.test(draft.hero)) {
    // Replace hyphens/apostrophes in the name with spaces for worker compatibility
    name = name.replace(/['''-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  fd.set('name', name);
  fd.set('category', draft.replaces?.category || draft.category);
  fd.set('hero', draft.hero);
  if (draft.subcategory) fd.set('subcategory', draft.subcategory);
  fd.set('tags', JSON.stringify(draft.tags));
  if (!draft.replaces) {
    // the site's three choices: a name the catalog lists, a new one, or nobody (Anonymous)
    if (draft.authorMode === 'existing' && draft.author) {
      fd.set('authorMode', 'existing');
      fd.set('authorName', draft.author);
    } else if (draft.authorMode === 'new' && draft.author) {
      fd.set('authorMode', 'new');
      fd.set('authorName', draft.author);
      if (draft.authorUrl) fd.set('authorUrl', draft.authorUrl);
    } else {
      fd.set('authorMode', 'new');
      fd.set('authorName', 'Anonymous');
    }
  }
  fd.set('extraMode', draft.extraMode);
  if (draft.extraMode !== 'none' && draft.extraName) {
    if (draft.extraOrigin === 'existing') fd.set('extraExistingName', draft.extraName);
    else {
      fd.set('extraName', draft.extraName);
      if (draft.extraUrl) fd.set('extraUrl', draft.extraUrl);
    }
  }
  if (draft.video) fd.set('previewVideo', draft.video);

  const styled = styles.length > 1;
  if (styled) {
    fd.set('styled', '1');
    fd.set('styles', JSON.stringify(styles.map((s) => ({ label: s.label, colors: s.colors }))));
  }
  styles.forEach((style, i) => {
    const suffix = i === 0 ? '' : ` Style ${i + 1}`;
    const base = `${draft.replaces?.name || draft.name}${suffix}`;
    fd.set(i === 0 ? 'modZip' : `modZip${i + 1}`, blobOf(vpkArchive(base, style.vpk)), `${base}.zip`);
    fd.set(i === 0 ? 'preview' : `preview${i + 1}`, blobOf(style.preview), `${base}.webp`);
  });
  return fd;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** POST /api/submit with the form above; the worker answers with the pull request it opened. */
export async function submitMod({ draft, styles, token, fetchImpl = fetch, api = UPLOAD_API }: {
  draft: Draft; styles: UploadStyle[]; token: string; fetchImpl?: typeof fetch; api?: string;
}): Promise<UploadReply> {
  const res = await fetchImpl(`${api}/api/submit`, { method: 'POST', headers: auth(token), body: uploadForm(draft, styles) });
  const data = await res.json().catch(() => null) as (Partial<UploadReply> & { error?: string; message?: string }) | null;
  if (!res.ok || !data || data.error || !data.prUrl) throw new Error(data?.message || data?.error || t('Загрузка не удалась: HTTP {0}', res.status));
  return { ok: true, id: String(data.id || ''), prUrl: String(data.prUrl) };
}

/** GET /api/status: the quota and cooldown the worker keeps for this caller. */
export async function uploadStatus({ token, fetchImpl = fetch, api = UPLOAD_API }: {
  token: string; fetchImpl?: typeof fetch; api?: string;
}): Promise<UploadStatus> {
  if (!token) throw new Error(t('Нет ключа загрузки'));
  const res = await fetchImpl(`${api}/api/status`, { headers: auth(token) });
  const data = await res.json().catch(() => null) as Partial<UploadStatus> | null;
  if (!res.ok || !data) throw new Error(t('Не удалось узнать лимит загрузки'));
  return {
    canSubmitNow: data.canSubmitNow === true,
    nextSubmitInSeconds: Number(data.nextSubmitInSeconds) || 0,
    submissionsUsed: Number(data.submissionsUsed) || 0,
    submissionsMax: Number(data.submissionsMax) || 0,
    windowResetInSeconds: Number(data.windowResetInSeconds) || 0,
  };
}

/** The app token: the encrypted one built into a release (tools/uploader-token.mjs from the
 * `UPLOADER_APP_TOKEN` GitHub secret). This is the only source: there is no way for a user to
 * paste or save a key of their own. */
export function uploadToken(embedded: string | null = embeddedUploadToken()): string | null {
  const built = String(embedded || '').trim();
  return built || null;
}
