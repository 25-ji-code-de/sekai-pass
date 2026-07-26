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
          if (action === 'keys') showKeys(target);
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
          ${
            a.token_endpoint_auth_method === 'private_key_jwt'
              ? `<button data-action="keys" data-client-id="${escapeHtml(a.client_id)}">管理公钥</button>`
              : ''
          }
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
          const wasPublic = existing.token_endpoint_auth_method !== 'private_key_jwt';
          const nowConfidential = payload.token_endpoint_auth_method === 'private_key_jwt';
          const saved = await api.put(`/apps/${encodeURIComponent(existing.client_id)}`, payload, {
            headers: api.getAuthHeaders(),
          });
          showSuccess('已保存');
          /*
           * 从 none 切到 private_key_jwt 之后，这个应用的 token 交换会立刻
           * 开始报 `Public key not found` —— 除非已经登记过公钥。
           *
           * 原来这里只弹一句「已保存」就把面板擦掉，切换的人不会知道自己
           * 刚把一个在跑的应用弄停了。创建流程有 showNextSteps 讲这件事，
           * 编辑流程一直没有。
           *
           * 只在**真的没有可用公钥**时才提示：已经登记过的人不该被唠叨。
           */
          if (wasPublic && nowConfidential && (await hasNoActiveKey(existing.client_id))) {
            warnMissingKey(saved?.application ?? existing);
          } else {
            container.innerHTML = '';
          }
        } else {
          const created = await api.post('/apps', payload, { headers: api.getAuthHeaders() });
          // showNextSteps 写的就是这个 container。原来这里无条件
          // `container.innerHTML = ''`，等于刚渲染完就擦掉 ——
          // 创建成功后那一屏从来没真的显示出来过。
          showNextSteps(created.application);
        }
        await loadApps();
      } catch (error) {
        showError(formatApiError(error));
      } finally {
        setLoading(btn, false);
      }
    });
  }

  /**
   * 创建成功后的下一步指引。
   *
   * 这里**没有 client_secret**。SEKAI Pass 的
   * `token_endpoint_auth_methods_supported` 只有 `none` 与 `private_key_jwt`，
   * 服务端从来不拿 client_secret 认证任何东西。之前这一屏给的是一串
   * 「只显示这一次」的随机字符 —— 接入方会把它配进后端，然后发现根本用不上，
   * 或者更糟：以为自己的应用因此就是机密客户端了。
   */
  function showNextSteps(app) {
    const container = document.getElementById('app-form-container');
    const needsKey = app.token_endpoint_auth_method === 'private_key_jwt';

    container.innerHTML = `
      <div class="secret-reveal">
        <h3>「${escapeHtml(app.name)}」已创建</h3>

        <dl class="app-meta">
          <dt>Client ID</dt>
          <dd><code class="secret-value">${escapeHtml(app.client_id)}</code></dd>
        </dl>

        <p class="field-hint">
          <strong>没有 client_secret。</strong>
          SEKAI Pass 只支持 <code>none</code>（公开客户端，靠 PKCE）与
          <code>private_key_jwt</code> 两种客户端认证方式，两种都不用密钥字符串。
        </p>

        ${
          needsKey
            ? `<p class="warn-text">
                 这是机密客户端，<strong>还需要登记公钥才能取到 token</strong>。
                 在应用卡片上点「管理公钥」。
               </p>`
            : `<p class="field-hint">
                 公开客户端直接用授权码 + PKCE 即可，无需任何额外配置。
               </p>`
        }

        <div class="form-actions">
          <button id="copy-client-id">复制 Client ID</button>
          <button id="steps-done" class="btn-secondary">知道了</button>
        </div>
      </div>
    `;

    document.getElementById('copy-client-id').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(app.client_id);
        showSuccess('已复制到剪贴板');
      } catch {
        showError('复制失败，请手动选中');
      }
    });
    document.getElementById('steps-done').addEventListener('click', () => {
      container.innerHTML = '';
    });
  }

  /**
   * 这个应用有没有可用的公钥。
   *
   * 查不到就当作「没有」—— 提示一句多余的话，代价远小于让人以为一切正常
   * 而实际上应用已经取不到 token。
   */
  async function hasNoActiveKey(clientId) {
    try {
      const data = await api.get(`/apps/${encodeURIComponent(clientId)}/keys`, {
        headers: api.getAuthHeaders(),
      });
      return !(data.keys || []).some((k) => k.status === 'active');
    } catch {
      return true;
    }
  }

  /** 切成机密客户端但还没有公钥时的提示。 */
  function warnMissingKey(app) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="app-form">
        <h3>已切换为机密客户端</h3>
        <p class="warn-text">
          这个应用现在用 <code>private_key_jwt</code> 认证，但<strong>还没有登记任何公钥</strong>。
          在登记之前，它<strong>取不到 token</strong> —— 正在用它登录的用户会立刻失败。
        </p>
        <p class="field-hint">
          密钥对由你自己生成，私钥不要交给我们；这里只登记公钥。
        </p>
        <div class="form-actions">
          <button id="warn-goto-keys">去登记公钥</button>
          <button id="warn-dismiss" class="btn-secondary">稍后再说</button>
        </div>
      </div>
    `;

    document.getElementById('warn-goto-keys').addEventListener('click', () => {
      showKeys(app);
    });
    document.getElementById('warn-dismiss').addEventListener('click', () => {
      container.innerHTML = '';
    });
  }

  function confirmDelete(target) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="app-form danger-zone">
        <h3>删除「${escapeHtml(target.name)}」</h3>
        <p class="warn-text">
          这会同时吊销该应用已签发的<strong>全部</strong> access token 与 refresh token，
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

  /*
   * 这里原本有个 confirmRotate（轮换 client_secret）。删掉了：
   * 轮换一个不认证任何东西的值，只会让人以为自己刚做了一次安全操作。
   *
   * private_key_jwt 的密钥轮换是**真的**有意义的，走下面的公钥管理：
   * 登记新公钥 → 客户端换用新私钥 → 撤销旧公钥，三步零停机。
   */

  /**
   * private_key_jwt 的公钥管理。
   *
   * 在这之前公钥只能手工插 client_keys 表 —— 也就是说选了 private_key_jwt
   * 的应用，在有人去改库之前根本取不到 token。
   */
  async function showKeys(target) {
    const container = document.getElementById('app-form-container');
    container.innerHTML = `
      <div class="app-form">
        <h3>「${escapeHtml(target.name)}」的公钥</h3>
        <p class="field-hint">
          客户端用私钥签 JWT 断言，服务端用这里登记的公钥验签（RFC 7523）。
          JWT header 里的 <code>kid</code> 必须与某个 Key ID 一致。
        </p>

        <div id="keys-list"><p class="loading-text">加载中...</p></div>

        <h4>登记新公钥</h4>
        <p class="warn-text">
          只贴<strong>公钥</strong>。私钥 JWK 只比公钥多几个字段（<code>d</code>、
          <code>p</code>、<code>q</code>…），复制时极容易带上 —— 带上了会被拒绝，
          但那时应当把那把私钥当作已泄露并重新生成。
        </p>

        <label for="k-alg">算法</label>
        <select id="k-alg">
          <option value="ES256">ES256（EC P-256，推荐）</option>
          <option value="RS256">RS256（RSA ≥ 2048 位）</option>
        </select>

        <label for="k-kid">Key ID（可选，留空则自动生成）</label>
        <input id="k-kid" type="text" autocomplete="off" placeholder="与 JWT header 的 kid 一致" />

        <label for="k-jwk">公钥 JWK（JSON）</label>
        <textarea id="k-jwk" rows="7" spellcheck="false"
          placeholder='{"kty":"EC","crv":"P-256","x":"...","y":"..."}'></textarea>

        <div class="form-actions">
          <button id="k-add">登记</button>
          <button id="k-close" class="btn-secondary">关闭</button>
        </div>
      </div>
    `;

    document.getElementById('k-close').addEventListener('click', () => {
      container.innerHTML = '';
    });
    document.getElementById('k-add').addEventListener('click', addKey);

    await loadKeys();

    async function loadKeys() {
      const listEl = document.getElementById('keys-list');
      if (!listEl) return;
      try {
        const data = await api.get(`/apps/${encodeURIComponent(target.client_id)}/keys`, {
          headers: api.getAuthHeaders(),
        });
        const keys = data.keys || [];

        if (keys.length === 0) {
          listEl.innerHTML = `
            <div class="empty-state">
              <p>还没有登记公钥。</p>
              <p class="text-dimmed">在登记之前，这个应用取不到 token。</p>
            </div>
          `;
          return;
        }

        listEl.innerHTML = `<ul class="key-list">${keys.map(renderKeyRow).join('')}</ul>`;
        listEl.querySelectorAll('[data-key-action]').forEach((btn) => {
          btn.addEventListener('click', () => onKeyAction(btn.dataset.keyAction, btn.dataset.keyId));
        });
      } catch (error) {
        listEl.innerHTML = '';
        showError(formatApiError(error));
      }
    }

    function renderKeyRow(k) {
      const revoked = k.status === 'revoked';
      const created = new Date(k.created_at).toLocaleString('zh-CN');
      return `
        <li class="key-row${revoked ? ' key-row-revoked' : ''}">
          <div class="key-row-main">
            <code>${escapeHtml(k.key_id)}</code>
            <span class="app-badge">${escapeHtml(k.algorithm)}</span>
            <span class="app-badge">${revoked ? '已撤销' : '生效中'}</span>
          </div>
          <div class="key-row-meta text-dimmed">登记于 ${escapeHtml(created)}</div>
          <div class="key-row-actions">
            <button data-key-action="${revoked ? 'activate' : 'revoke'}"
                    data-key-id="${escapeHtml(k.key_id)}" class="btn-secondary">
              ${revoked ? '恢复' : '撤销'}
            </button>
            <button data-key-action="delete" data-key-id="${escapeHtml(k.key_id)}" class="btn-danger">删除</button>
          </div>
        </li>
      `;
    }

    async function onKeyAction(action, keyId) {
      const base = `/apps/${encodeURIComponent(target.client_id)}/keys/${encodeURIComponent(keyId)}`;
      try {
        if (action === 'delete') {
          // 撤销是可逆的，删除不是 —— 只有删除需要再确认一次
          if (!window.confirm(`删除公钥 ${keyId}？用它签名的客户端会立刻无法取 token。`)) return;
          await api.delete(base, { headers: api.getAuthHeaders() });
          showSuccess('已删除');
        } else {
          const status = action === 'revoke' ? 'revoked' : 'active';
          await api.patch(base, { status }, { headers: api.getAuthHeaders() });
          showSuccess(status === 'revoked' ? '已撤销' : '已恢复');
        }
        await loadKeys();
      } catch (error) {
        showError(formatApiError(error));
      }
    }

    async function addKey(e) {
      const btn = e.currentTarget;
      const raw = document.getElementById('k-jwk').value.trim();

      let jwk;
      try {
        jwk = JSON.parse(raw);
      } catch {
        showError('公钥 JWK 不是合法的 JSON');
        return;
      }

      setLoading(btn, true);
      try {
        await api.post(
          `/apps/${encodeURIComponent(target.client_id)}/keys`,
          {
            public_key_jwk: jwk,
            algorithm: document.getElementById('k-alg').value,
            key_id: document.getElementById('k-kid').value.trim() || undefined,
          },
          { headers: api.getAuthHeaders() },
        );
        showSuccess('已登记');
        document.getElementById('k-jwk').value = '';
        document.getElementById('k-kid').value = '';
        await loadKeys();
      } catch (error) {
        showError(formatApiError(error));
      } finally {
        setLoading(btn, false);
      }
    }
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
