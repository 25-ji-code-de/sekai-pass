// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight client for Nightcord Storage v2 (storage.nightcord.de5.net).
 * Uploads via the preferred /v2/upload/init + direct gateway + /complete flow
 * and returns a public HTTPS URL (r2.*) for avatar use.
 *
 * @see https://storage.nightcord.de5.net/?format=md
 */
export class FileUploadService {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] upload host
   * @param {string} [opts.publicBaseUrl] public media host (preferred for GET)
   * @param {number} [opts.timeout]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'https://storage.nightcord.de5.net').replace(/\/$/, '');
    this.publicBaseUrl = (opts.publicBaseUrl || 'https://r2.nightcord.de5.net').replace(/\/$/, '');
    this.timeout = opts.timeout || 60000;
  }

  /**
   * @param {File|Blob} file
   * @param {string} [filename]
   * @param {(percent: number) => void} [onProgress]
   * @param {Object} [opts]
   * @param {'image'|'file'|'sticker'} [opts.kind]
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @returns {Promise<{
   *   uuid: string,
   *   key: string,
   *   type: string,
   *   size: number,
   *   size_bytes: number,
   *   name: string,
   *   kind: string,
   *   path: string,
   *   url: string,
   *   w?: number,
   *   h?: number
   * }>}
   */
  async upload(file, filename, onProgress, opts = {}) {
    if (!file || !(file instanceof Blob)) {
      throw new Error('Invalid file object');
    }

    const name = filename || file.name || 'avatar';
    const kind = opts.kind || FileUploadService.inferKind(file.type);

    return this.uploadDirect(file, name, onProgress, opts, kind);
  }

  async uploadDirect(file, name, onProgress, opts, kind) {
    const init = await this.jsonPost('/v2/upload/init', {
      name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      kind,
      ...(opts.width != null ? { w: opts.width } : {}),
      ...(opts.height != null ? { h: opts.height } : {})
    });

    const form = new FormData();
    for (const [fieldName, value] of Object.entries(init.upload?.fields || {})) {
      form.append(fieldName, value);
    }
    form.append('file', file, name);

    await this.xhrUpload({
      method: init.upload?.method || 'POST',
      url: init.upload?.url,
      body: form,
      onProgress,
      completeOnLoad: false
    });

    const raw = await this.jsonPost('/v2/upload/complete', { token: init.complete_token });
    if (typeof onProgress === 'function') onProgress(100);
    return this.normalizeResponse(raw);
  }

  async jsonPost(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await this.responseError(res);
      throw err;
    }
    return res.json();
  }

  async responseError(res) {
    let message = `Upload failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore
    }
    const err = new Error(message);
    err.status = res.status;
    return err;
  }

  xhrUpload({ method, url, body, onProgress, completeOnLoad = true }) {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error('Upload URL missing'));
        return;
      }
      const xhr = new XMLHttpRequest();

      if (typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const cap = completeOnLoad ? 100 : 99;
            onProgress(Math.min(cap, Math.round((e.loaded / e.total) * cap)));
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr);
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => reject(new Error('Upload timeout')));

      xhr.open(method, url);
      xhr.send(body);
    });
  }

  /**
   * Normalize v2 upload JSON into a client-friendly shape with absolute public URL.
   * @param {Record<string, unknown>} raw
   */
  normalizeResponse(raw) {
    const uuid = String(raw.uuid || raw.key || '');
    if (!uuid) {
      throw new Error('Upload response missing resource id');
    }

    const path = typeof raw.url === 'string' && raw.url.startsWith('/')
      ? raw.url
      : FileUploadService.pathFor(uuid, raw.kind);

    return {
      uuid,
      key: uuid,
      type: raw.type || '',
      // Prefer size_bytes (bytes); fall back to legacy size-as-bytes if present without size_bytes
      size: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size) || 0,
      size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size) || 0,
      name: raw.name || '',
      kind: raw.kind || 'file',
      path,
      url: this.toPublicUrl(path),
      ...(raw.w != null ? { w: Number(raw.w) } : {}),
      ...(raw.h != null ? { h: Number(raw.h) } : {})
    };
  }

  /**
   * Build absolute public HTTPS URL for a path, key, or uuid.
   * @param {string} pathOrKey e.g. "/images/{uuid}", "images/{uuid}", or "{uuid}"
   * @param {string} [kind] used when only a bare uuid is given
   * @returns {string}
   */
  getFileUrl(pathOrKey, kind) {
    if (!pathOrKey) return this.publicBaseUrl;
    if (/^https?:\/\//i.test(pathOrKey)) return pathOrKey;

    const path = pathOrKey.startsWith('/')
      ? pathOrKey
      : pathOrKey.includes('/')
        ? `/${pathOrKey}`
        : FileUploadService.pathFor(pathOrKey, kind);

    return this.toPublicUrl(path);
  }

  /**
   * @param {string} path must start with /
   * @returns {string}
   */
  toPublicUrl(path) {
    return `${this.publicBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * @param {string} uuid
   * @param {string} [kind]
   * @returns {string}
   */
  static pathFor(uuid, kind) {
    const segment =
      kind === 'image' ? 'images' : kind === 'sticker' ? 'stickers' : 'files';
    return `/${segment}/${uuid}`;
  }

  /**
   * @param {string} [mime]
   * @returns {'image'|'file'|undefined}
   */
  static inferKind(mime) {
    if (!mime) return undefined;
    if (mime.startsWith('image/')) return 'image';
    return 'file';
  }

  /**
   * @param {File|Blob} file
   * @param {number} maxSize bytes
   */
  static validateSize(file, maxSize) {
    return file.size <= maxSize;
  }

  /**
   * @param {File|Blob} file
   * @param {string[]} allowedTypes e.g. ['image/*']
   */
  static validateType(file, allowedTypes) {
    if (!file.type) return false;
    return allowedTypes.some((type) => {
      if (type.endsWith('/*')) {
        const prefix = type.slice(0, -1); // 'image/' from 'image/*'
        return file.type.startsWith(prefix);
      }
      return file.type === type;
    });
  }

  /**
   * @param {number} bytes
   * @returns {string}
   */
  static formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}
