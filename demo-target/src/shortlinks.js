import { MemoryStore } from './store.js';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export function normalizeSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (slug.length === 0) throw new ValidationError('slug is required');
  if (slug.includes('/')) throw new ValidationError('slug must not contain "/"');
  return slug;
}

export function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class ShortlinkService {
  constructor(store = new MemoryStore()) {
    this.store = store;
  }

  create(rawSlug, url) {
    const slug = normalizeSlug(rawSlug);
    if (!isValidHttpUrl(url)) throw new ValidationError(`url must be an http(s) URL: ${url}`);
    if (this.store.has(slug)) throw new ConflictError(`slug already exists: ${slug}`);
    const record = { slug, url, createdAt: new Date().toISOString() };
    this.store.put(slug, record);
    return record;
  }

  resolve(rawSlug) {
    const slug = normalizeSlug(rawSlug);
    const record = this.store.get(slug);
    if (!record) throw new NotFoundError(`no such slug: ${slug}`);
    return record;
  }
}
