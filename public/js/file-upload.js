// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight client for the Nightcord storage proxy (storage.nightcord.de5.net).
 * Uploads via PUT and returns a public HTTPS URL for avatar use.
 */
export class FileUploadService {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeout]
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || 'https://storage.nightcord.de5.net';
    this.timeout = opts.timeout || 60000;
  }

  /**
   * @param {File|Blob} file
   * @param {string} [filename]
   * @param {(percent: number) => void} [onProgress]
   * @returns {Promise<{key: string, url: string, size: number}>}
   */
  upload(file, filename, onProgress) {
    if (!file || !(file instanceof Blob)) {
      return Promise.reject(new Error('Invalid file object'));
    }

    const name = filename || file.name || 'avatar';

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Invalid server response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => reject(new Error('Upload timeout')));

      xhr.open('PUT', this.baseUrl);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
      xhr.send(file);
    });
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  getFileUrl(key) {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key;
    return `${this.baseUrl}/${cleanKey}`;
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
