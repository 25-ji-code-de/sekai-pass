// SPDX-License-Identifier: Apache-2.0
// Client-side encryption utilities
export async function encryptPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const timestamp = Date.now().toString();
  const combined = password + '|' + saltHex + '|' + timestamp;
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  // Chunked base64 — avoid apply/spread argument limits
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function generateNonce() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function getFingerprint() {
  const data = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset()
  ].join('|');
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// API client
export class APIClient {
  constructor(baseURL = '') {
    this.baseURL = baseURL;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const token = localStorage.getItem('token');

    const config = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      let data = null;
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }

      if (!response.ok) {
        throw {
          status: response.status,
          message: (data && (data.error || data.message)) || 'Request failed',
          data
        };
      }

      return data;
    } catch (error) {
      if (error.status === 401) {
        // Token expired or invalid
        localStorage.removeItem('token');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
      throw error;
    }
  }

  async get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  async post(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async put(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async patch(endpoint, data, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }

  setAuthToken(token) {
    this.token = token;
  }

  getAuthHeaders() {
    if (this.token) {
      return { Authorization: `Bearer ${this.token}` };
    }
    return {};
  }
}

// Show error message
export function showError(message) {
  const errorDiv = document.getElementById('error-message');
  if (errorDiv) {
    errorDiv.textContent = `⚠️ ${message}`;
    errorDiv.style.display = 'block';
  }
}

// Show success message
export function showSuccess(message) {
  const successDiv = document.getElementById('success-message');
  if (successDiv) {
    successDiv.textContent = `✓ ${message}`;
    successDiv.style.display = 'block';
  }
}

// Hide messages
export function hideMessages() {
  const errorDiv = document.getElementById('error-message');
  const successDiv = document.getElementById('success-message');
  if (errorDiv) errorDiv.style.display = 'none';
  if (successDiv) successDiv.style.display = 'none';
}

/**
 * HTML 转义。同时覆盖元素上下文与属性上下文。
 *
 * 页面里到处在用模板字符串拼 innerHTML，任何来自 query string、API 响应
 * 或用户资料的值都必须先过这里。
 *
 * `&` 必须最先替换，否则会把后面生成的实体再转义一次。
 * 单引号也要转义 —— 模板里目前都用双引号包属性，但不该依赖这一点。
 * `null` / `undefined` 转成空串，避免把字面量 "undefined" 渲染进页面。
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Get query parameters
export function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const result = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

// Set loading state
export function setLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.innerHTML = '<span class="loading"></span>';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}
