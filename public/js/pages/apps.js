// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The 25-ji-code-de Team

/**
 * 开放平台 —— OAuth 应用自助管理。
 *
 * 在这个页面之前，注册一个 OAuth 应用只能手工往 D1 里 INSERT。
 *
 * 所有插值一律过 escapeHtml —— 应用名、描述、回调地址都是用户输入，
 * 而这里全靠模板字符串拼 innerHTML。
 */
import { showError, showSuccess, setLoading, escapeHtml } from '../utils.js';

const AUTH_METHOD_LABELS = {
  none: '公开客户端（PKCE）',
  private_key_jwt: '机密客户端（private_key_jwt）',
};

export async function renderApps(app, api, navigate) {
  const token = localStorage.getItem('token');
  if (!token) {
    navigate('/login');
    return;
  }
  api.setAuthToken(token);

  app.innerHTML = `
    <div class="container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>

      <div class="page-header">
        <h2>开放平台</h2>
        <p class="page-subtitle">管理你的 OAuth 应用</p>
      </div>

      <div id="error-message" class="error" style="display: none;"></div>
      <div id="success-message" class="success" style="display: none;"></div>

      <div id="apps-list"><p class="loading-text">加载中...</p></div>

      <div class="apps-actions">
        <button id="new-app-btn">创建应用</button>
        <button id="back-btn" class="btn-secondary">返回</button>
      </div>

      <div id="app-form-container"></div>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => navigate('/'));
  document.getElementById('new-app-btn').addEventListener('click', () => showForm(null));

  await loadApps();

  /** 拉取并渲染应用列表。 */
  async function loadApps() {
    const listEl = document.getElementById('apps-list');
    try {
      const data = await api.get('/apps', { headers: api.getAuthHeaders() });
      const apps = data.applications || [];

      if (apps.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <p>还没有应用。</p>
            <p class="text-dimmed">创建一个之后，就能用它接入 SEKAI Pass 登录。</p>
          </div>
        `;
        return;
      }

      listEl.innerHTML = apps.map(renderAppCard).join('');

      listEl.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const { action, clientId } = btn.dataset;
          const target = apps.find((a) => a.client_id === clientId);
          if (action === 'edit') showForm(target);
          if (action === 'delete') confirmDelete(target);
          if (action === 'rotate') confirmRotate(target);
        });
      });

      document.querySelector('.apps-actions #new-app-btn').disabled =
        apps.length >= (data.limit ?? Infinity);
    } catch (error) {
      listEl.innerHTML = '';
      showError(error?.message || '获取应用列表失败');
    }
  }

  function renderAppCard(a) {
    const uris = a.redirect_uris
      .map((u) => `<li><code>${escapeHtml(u)}</code></li>`)
      .join('');
    const method = AUTH_METHOD_LABELS[a.token_endpoint_auth_method] || a.token_endpoint_auth_method;

    return `
      <div class="app-card">
        <div class="app-card-header">
          <h3>${escapeHtml(a.name)}</h3>
          <span class="app-badge">${escapeHtml(method)}</span>
        </div>
        ${a.description ? `<p class="app-desc">${escapeHtml(a.description)}</p>` : ''}
        <dl class="app-meta">
          <dt>Client ID</dt>
          <dd><code>${escapeHtml(a.client_id)}</code></dd>
          <dt>回调地址</dt>
          <dd><ul class="uri-list">${uris}</ul></dd>
          ${a.homepage_url ? `<dt>主页</dt><dd><code>${escapeHtml(a.homepage_url)}</code></dd>` : ''}
        </dl>
        <div class="app-card-actions">
          <button data-action="edit" data-client-id="${escapeHtml(a.client_id)}">编辑</button>
          <button data-action="rotate" data-client-id="${escapeHtml(a.client_id)}" class="btn-secondary">轮换密钥</button>
          <button data-action="delete" data-client-id="${escapeHtml(a.client_id)}" class="btn-danger">删除</button>
        </div>
      </div>
    `;
  }

  /** 创建 / 编辑表单。existing 为 null 表示创建。 */
  function showForm(existing) {
    const container = document.getElementById('app-form-container');
    const isEdit = !!existing;

    container.innerHTML = `
      <div class="app-form">
        <h3>${isEdit ? '编辑应用' : '创建应用'}</h3>

        <label for="f-name">应用名</label>
        <input id="f-name" type="text" maxlength="64" value="${escapeHtml(existing?.name ?? '')}" />

        <label for="f-desc">描述（可选）</label>
        <input id="f-desc" type="text" maxlength="500" value="${escapeHtml(existing?.description ?? '')}" />

        <label for="f-home">主页（可选）</label>
        <input id="f-home" type="url" value="${escapeHtml(existing?.homepage_url ?? '')}" />

        <label for="f-uris">回调地址（每行一个）</label>
        <textarea id="f-uris" rows="4">${escapeHtml((existing?.redirect_uris ?? []).join('\n'))}</textarea>
        <p class="field-hint">必须是 https；本地开发可用 http://localhost。不能带 # 片段。</p>

        <label for="f-method">客户端类型</label>
        <select id="f-method">
          <option value="none">${AUTH_METHOD_LABELS.none}</option>
          <option value="private_key_jwt">${AUTH_METHOD_LABELS.private_key_jwt}</option>
        </select>

        <div class="form-actions">
          <button id="f-submit">${isEdit ? '保存' : '创建'}</button>
          <button id="f-cancel" class="btn-secondary">取消</button>
        </div>
      </div>
    `;

    document.getElementById('f-method').value = existing?.token_endpoint_auth_method ?? 'none';
    document.getElementById('f-cancel').addEventListener('click', () => {
      container.innerHTML = '';
    });

    document.getElementById('f-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const payload = {
        name: document.getElementById('f-name').value.trim(),
        description: document.getElementById('f-desc').value.trim() || null,
        homepage_url: document.getElementById('f-home').value.trim() || null,
        redirect_uris: document
          .getElementById('f-uris')
          .value.split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        token_endpoint_auth_method: document.getElementById('f-method').value,
      };

      setLoading(btn, true);
      try {
        if (isEdit) {
          await api.put(`/apps/${encodeURIComponent(existing.client_id)}`, payload, {
            headers: api.getAuthHeaders(),
          });
          showSuccess('已保存');
        } else {
          const created = await api.post('/apps', payload, { headers: api.getAuthHeaders() });
          showSecretOnce(created.client_secret);
        }
        container.innerHTML = '';
        await loadApps();
      } catch (error) {
        showError(formatApiError(error));
      } finally {
        setLoading(btn, false);
      }
    });
  }

  /**
   * client_secret 只在创建时返回一次，之后服务端不再吐出来。
   * 所以必须让用户当场复制走。
   */
  function showSecretOnce(secret) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="secret-reveal">
        <h3>应用已创建</h3>
        <p class="warn-text">
          下面这串 client_secret <strong>只显示这一次</strong>，关掉就再也看不到了。
          请现在复制保存。
        </p>
        <code class="secret-value">${escapeHtml(secret)}</code>
        <div class="form-actions">
          <button id="copy-secret">复制</button>
          <button id="secret-done" class="btn-secondary">我已保存</button>
        </div>
      </div>
    `;

    document.getElementById('copy-secret').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(secret);
        showSuccess('已复制到剪贴板');
      } catch {
        showError('复制失败，请手动选中');
      }
    });
    document.getElementById('secret-done').addEventListener('click', () => {
      container.innerHTML = '';
    });
  }

  function confirmDelete(target) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="app-form danger-zone">
        <h3>删除「${escapeHtml(target.name)}」</h3>
        <p class="warn-text">
          这会同时吊销该应用已签发的**全部** access token 与 refresh token，
          正在使用它登录的用户会立刻掉线。此操作不可撤销。
        </p>
        <label for="f-confirm">输入应用名以确认</label>
        <input id="f-confirm" type="text" autocomplete="off" />
        <div class="form-actions">
          <button id="f-delete" class="btn-danger" disabled>确认删除</button>
          <button id="f-cancel-del" class="btn-secondary">取消</button>
        </div>
      </div>
    `;

    const input = document.getElementById('f-confirm');
    const delBtn = document.getElementById('f-delete');
    input.addEventListener('input', () => {
      delBtn.disabled = input.value !== target.name;
    });

    document.getElementById('f-cancel-del').addEventListener('click', () => {
      container.innerHTML = '';
    });
    delBtn.addEventListener('click', async (e) => {
      setLoading(e.currentTarget, true);
      try {
        await api.delete(`/apps/${encodeURIComponent(target.client_id)}`, {
          headers: api.getAuthHeaders(),
        });
        showSuccess('已删除');
        container.innerHTML = '';
        await loadApps();
      } catch (error) {
        showError(formatApiError(error));
      }
    });
  }

  function confirmRotate(target) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="app-form danger-zone">
        <h3>轮换「${escapeHtml(target.name)}」的密钥</h3>
        <p class="warn-text">
          旧的 client_secret 会立刻失效。所有用它换 token 的服务都要同步更新。
        </p>
        <div class="form-actions">
          <button id="f-rotate" class="btn-danger">确认轮换</button>
          <button id="f-cancel-rot" class="btn-secondary">取消</button>
        </div>
      </div>
    `;

    document.getElementById('f-cancel-rot').addEventListener('click', () => {
      container.innerHTML = '';
    });
    document.getElementById('f-rotate').addEventListener('click', async (e) => {
      setLoading(e.currentTarget, true);
      try {
        const result = await api.post(
          `/apps/${encodeURIComponent(target.client_id)}/rotate-secret`,
          {},
          { headers: api.getAuthHeaders() },
        );
        showSecretOnce(result.client_secret);
      } catch (error) {
        showError(formatApiError(error));
      }
    });
  }
}

/**
 * 把后端的字段级校验错误拼成一句话。
 *
 * APIClient 抛的是 { status, message, data }，字段级细节在 data.details 里
 * （见 utils.js:73）。
 */
function formatApiError(error) {
  const details = error?.data?.details;
  if (Array.isArray(details) && details.length) {
    return details.map((d) => `${d.field}: ${d.message}`).join('；');
  }
  return error?.message || '操作失败';
}
