// SPDX-License-Identifier: Apache-2.0

/**
 * Keep initials visible until an HTTPS avatar has loaded successfully.
 */
export function mountAvatars(root = document) {
  root.querySelectorAll('[data-avatar-url]').forEach((container) => {
    if (container.dataset.avatarMounted === 'true') return;
    container.dataset.avatarMounted = 'true';

    const url = container.dataset.avatarUrl?.trim();
    if (!url) return;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return;
    }
    if (parsedUrl.protocol !== 'https:') return;

    const image = new Image();
    image.className = 'entity-avatar__image';
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => {
      container.classList.add('has-image');
      container.prepend(image);
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = parsedUrl.href;
  });
}

mountAvatars();
