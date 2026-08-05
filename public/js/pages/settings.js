// SPDX-License-Identifier: Apache-2.0
import { showError, showSuccess, setLoading } from '../utils.js';
import { FileUploadService } from '../file-upload.js';

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BIO_LENGTH = 200;

export async function renderSettings(app, api, navigate) {
  const token = localStorage.getItem('token');
  if (!token) {
    navigate('/login');
    return;
  }

  api.setAuthToken(token);
  const uploader = new FileUploadService();

  app.innerHTML = `
    <div class="container settings-container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>

      <div class="settings-header">
        <h2>System Settings // Account</h2>
      </div>

      <div id="error-message" class="error" style="display: none;"></div>
      <div id="success-message" class="success" style="display: none;"></div>

      <div class="settings-profile-section">
        <div class="avatar-preview" id="avatar-preview-box">
           <span class="initials" id="avatar-initials">--</span>
        </div>
        <div class="profile-meta">
           <div class="meta-row">
              <span class="label">IDENTITY:</span> <span class="value" id="disp-username">LOADING...</span>
           </div>
           <div class="meta-row">
              <span class="label">EMAIL:</span> <span class="value" id="disp-email">...</span>
           </div>
           <div class="meta-row">
              <span class="label">STATUS:</span> <span class="value" style="color: rgb(var(--success-color));">ACTIVE</span>
           </div>
           <div class="meta-row bio-row" id="disp-bio-row" style="display: none;">
              <span class="label">BIO:</span> <span class="value" id="disp-bio"></span>
           </div>
        </div>
      </div>

      <div class="form-divider"></div>

      <form id="settings-form">
        <input type="hidden" id="username" />
        <input type="hidden" id="email" />

        <div class="form-group">
          <label for="display_name">Display Name // 昵称</label>
          <input type="text" id="display_name" maxlength="50" placeholder="Enter your display name" />
        </div>

        <div class="form-group">
          <label for="bio">Signature // 个性签名</label>
          <textarea id="bio" maxlength="${MAX_BIO_LENGTH}" rows="3" placeholder="写点什么介绍一下自己…"></textarea>
          <span class="input-hint"><span id="bio-count">0</span> / ${MAX_BIO_LENGTH}</span>
        </div>

        <div class="form-group">
          <label for="avatar_url">Avatar // 头像</label>
          <div class="avatar-upload-row">
            <input type="url" id="avatar_url" maxlength="500" placeholder="https://example.com/avatar.jpg" />
            <button type="button" id="avatar-upload-btn" class="btn-secondary btn-auto avatar-upload-btn">上传图片</button>
            <input type="file" id="avatar-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden />
          </div>
          <div id="upload-progress" class="upload-progress hidden">
            <div class="upload-progress-bar"><div id="upload-fill" class="upload-progress-fill"></div></div>
            <span id="upload-percent" class="upload-percent">0%</span>
          </div>
          <span class="input-hint">上传图片（≤2MB，JPEG/PNG/GIF/WebP）或填写 HTTPS 直链。</span>
        </div>

        <div class="settings-actions">
           <button type="button" id="back-btn" class="btn-secondary btn-auto">返回</button>
           <button type="submit" id="save-btn" class="btn-auto" style="min-width: 140px;">保存修改</button>
        </div>
      </form>

      <div class="form-divider external-auth-divider"></div>
      <section class="settings-login-methods" aria-labelledby="login-methods-title">
        <div class="settings-section-head">
          <h3 id="login-methods-title">登录方式</h3>
        </div>
        <div id="login-methods-list" class="login-methods-list">
          <div class="external-complete-loading">正在加载...</div>
        </div>
      </section>
    </div>

    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
  `;

  const avatarPreviewBox = document.getElementById('avatar-preview-box');
  const bioInput = document.getElementById('bio');
  const bioCount = document.getElementById('bio-count');
  const avatarInput = document.getElementById('avatar_url');
  const avatarFileInput = document.getElementById('avatar-file');
  const avatarUploadBtn = document.getElementById('avatar-upload-btn');
  const uploadProgress = document.getElementById('upload-progress');
  const uploadFill = document.getElementById('upload-fill');
  const uploadPercent = document.getElementById('upload-percent');

  function renderInitials(username) {
    avatarPreviewBox.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'initials';
    span.innerText = username ? username.substring(0, 2).toUpperCase() : '??';
    avatarPreviewBox.appendChild(span);
  }

  function updateAvatarPreview(url, username) {
    if (!url || !url.trim()) {
      renderInitials(username);
      return;
    }

    try {
      const urlObj = new URL(url);
      if (urlObj.protocol !== 'https:') {
        renderInitials(username);
        return;
      }
    } catch {
      renderInitials(username);
      return;
    }

    avatarPreviewBox.innerHTML = '';
    const loadingSpan = document.createElement('span');
    loadingSpan.className = 'initials';
    loadingSpan.style.opacity = '0.5';
    loadingSpan.innerText = '...';
    avatarPreviewBox.appendChild(loadingSpan);

    const img = new Image();
    img.onload = () => {
      avatarPreviewBox.innerHTML = '';
      const displayImg = document.createElement('img');
      displayImg.src = url;
      avatarPreviewBox.appendChild(displayImg);
    };
    img.onerror = () => {
      renderInitials(username);
    };
    img.src = url;
  }

  function updateBioCount() {
    bioCount.textContent = String(bioInput.value.length);
  }

  function updateBioDisplay(bio) {
    const row = document.getElementById('disp-bio-row');
    const el = document.getElementById('disp-bio');
    if (bio && bio.trim()) {
      el.textContent = bio.trim();
      row.style.display = '';
    } else {
      el.textContent = '';
      row.style.display = 'none';
    }
  }

  document.getElementById('back-btn').addEventListener('click', () => {
    navigate('/dashboard');
  });

  let currentUser = {};

  const query = new URLSearchParams(window.location.search);
  if (query.get('external') === 'linked') showSuccess('第三方登录方式已绑定');
  if (query.get('external_error')) showError(query.get('external_error'));

  async function loadLoginMethods() {
    const list = document.getElementById('login-methods-list');
    try {
      const data = await api.get('/auth/external/accounts', {
        headers: api.getAuthHeaders()
      });
      list.replaceChildren();

      if (data.password_login_enabled) {
        const passwordRow = document.createElement('div');
        passwordRow.className = 'login-method-row';
        passwordRow.innerHTML = '<div class="login-method-icon login-method-password" aria-hidden="true">••</div><div class="login-method-name"><strong>密码</strong><span>已启用</span></div><span class="login-method-status">已连接</span>';
        list.appendChild(passwordRow);
      }

      const linked = new Map(data.accounts.map((account) => [account.id, account]));
      const allProviders = [...data.providers];
      for (const account of data.accounts) {
        if (!allProviders.some((provider) => provider.id === account.id)) allProviders.push(account);
      }

      for (const provider of allProviders) {
        const account = linked.get(provider.id);
        const row = document.createElement('div');
        row.className = 'login-method-row';

        const icon = document.createElement('img');
        icon.className = `login-method-icon provider-icon--${provider.id}`;
        icon.src = provider.icon;
        icon.alt = '';
        icon.width = 24;
        icon.height = 24;

        const name = document.createElement('div');
        name.className = 'login-method-name';
        const strong = document.createElement('strong');
        strong.textContent = provider.name;
        const detail = document.createElement('span');
        detail.textContent = account ? '已绑定' : '未绑定';
        name.append(strong, detail);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = account ? 'btn-link btn-link-danger' : 'btn-link';
        action.textContent = account ? '解除' : '绑定';
        if (!provider.available && account) {
          detail.textContent = '配置已停用';
        }
        if (!provider.available && !account) action.disabled = true;

        action.addEventListener('click', async () => {
          if (account) {
            if (!window.confirm(`解除 ${provider.name} 后将无法再用该账号登录。确定继续？`)) return;
            setLoading(action, true);
            try {
              await api.delete(`/auth/external/accounts/${encodeURIComponent(provider.id)}`, {
                headers: api.getAuthHeaders()
              });
              showSuccess(`${provider.name} 已解除绑定`);
              await loadLoginMethods();
            } catch (error) {
              showError(error.message || '解除绑定失败');
              setLoading(action, false);
            }
            return;
          }

          setLoading(action, true);
          try {
            const result = await api.post(`/auth/external/${encodeURIComponent(provider.id)}/start`, {
              mode: 'link'
            }, { headers: api.getAuthHeaders() });
            window.location.assign(result.authorization_url);
          } catch (error) {
            showError(error.message || '无法启动账号绑定');
            setLoading(action, false);
          }
        });

        row.append(icon, name, action);
        list.appendChild(row);
      }
    } catch (error) {
      list.textContent = error.message || '登录方式加载失败';
    }
  }

  loadLoginMethods();

  try {
    const user = await api.get('/auth/me', {
      headers: api.getAuthHeaders()
    });
    currentUser = user;

    document.getElementById('username').value = user.username;
    document.getElementById('email').value = user.email;
    document.getElementById('display_name').value = user.display_name || '';
    document.getElementById('avatar_url').value = user.avatar_url || '';
    bioInput.value = user.bio || '';
    updateBioCount();
    updateBioDisplay(user.bio);

    document.getElementById('disp-username').innerText = user.username;
    document.getElementById('disp-email').innerText = user.email;

    updateAvatarPreview(user.avatar_url, user.username);
  } catch (error) {
    showError('获取用户信息失败');
    if (error.status === 401) {
      localStorage.removeItem('token');
      navigate('/login');
    }
  }

  bioInput.addEventListener('input', updateBioCount);

  let previewTimeout;
  avatarInput.addEventListener('input', (e) => {
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      const username = currentUser.username || '??';
      updateAvatarPreview(e.target.value.trim(), username);
    }, 500);
  });

  avatarUploadBtn.addEventListener('click', () => {
    avatarFileInput.click();
  });

  avatarFileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    avatarFileInput.value = '';
    if (!file) return;

    if (!FileUploadService.validateType(file, ALLOWED_AVATAR_TYPES)) {
      showError('仅支持 JPEG / PNG / GIF / WebP 图片');
      return;
    }

    if (!FileUploadService.validateSize(file, MAX_AVATAR_SIZE)) {
      showError(`图片过大，最大 ${FileUploadService.formatSize(MAX_AVATAR_SIZE)}`);
      return;
    }

    avatarUploadBtn.disabled = true;
    uploadProgress.classList.remove('hidden');
    uploadFill.style.width = '0%';
    uploadPercent.textContent = '0%';

    try {
      const result = await uploader.upload(file, file.name, (percent) => {
        uploadFill.style.width = `${percent}%`;
        uploadPercent.textContent = `${percent}%`;
      }, { kind: 'image' });

      // v2 returns absolute public URL on r2.*; fall back to path/key rebuild.
      if (!result || (!result.url && !result.uuid && !result.key)) {
        throw new Error('Upload response missing resource id');
      }
      const url = result.url || uploader.getFileUrl(result.path || result.key || result.uuid, 'image');
      avatarInput.value = url;
      updateAvatarPreview(url, currentUser.username || '??');
      showSuccess('头像上传成功，记得保存修改');
    } catch (err) {
      showError(err.message || '上传失败，请重试');
    } finally {
      avatarUploadBtn.disabled = false;
      uploadProgress.classList.add('hidden');
    }
  });

  const form = document.getElementById('settings-form');
  const saveBtn = document.getElementById('save-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoading(saveBtn, true);

    const displayName = document.getElementById('display_name').value.trim();
    const avatarUrl = avatarInput.value.trim();
    const bio = bioInput.value.trim();

    if (bio.length > MAX_BIO_LENGTH) {
      showError(`个性签名长度不能超过 ${MAX_BIO_LENGTH} 个字符`);
      setLoading(saveBtn, false);
      return;
    }

    try {
      const updateData = {
        display_name: displayName,
        avatar_url: avatarUrl,
        bio
      };

      if (avatarUrl) {
        try {
          const urlObj = new URL(avatarUrl);
          if (urlObj.protocol !== 'https:') {
            showError('头像 URL 必须使用 HTTPS 协议');
            setLoading(saveBtn, false);
            return;
          }
        } catch {
          showError('请输入有效的 URL 地址');
          setLoading(saveBtn, false);
          return;
        }
      }

      const result = await api.put('/auth/profile', updateData, {
        headers: api.getAuthHeaders()
      });

      showSuccess('资料更新成功 // PROFILE UPDATED');

      if (result.user) {
        currentUser = { ...currentUser, ...result.user };
      } else {
        currentUser.display_name = displayName || null;
        currentUser.avatar_url = avatarUrl || null;
        currentUser.bio = bio || null;
      }

      updateBioDisplay(currentUser.bio);
      updateAvatarPreview(currentUser.avatar_url, currentUser.username);
    } catch (error) {
      showError(error.message || '更新失败，请重试');
    } finally {
      setLoading(saveBtn, false);
    }
  });
}
