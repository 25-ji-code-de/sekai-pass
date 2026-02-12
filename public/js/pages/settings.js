import { showError, showSuccess, setLoading } from '../utils.js';

export async function renderSettings(app, api, navigate) {
  const token = localStorage.getItem('token');
  if (!token) {
    navigate('/login');
    return;
  }

  api.setAuthToken(token);

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
              <span class="label">STATUS:</span> <span class="value" style="color: var(--success-color);">ACTIVE</span>
           </div>
        </div>
      </div>

      <div class="form-divider"></div>

      <form id="settings-form">
        <!-- Hidden inputs to store original values if needed -->
        <input type="hidden" id="username" />
        <input type="hidden" id="email" />

        <div class="form-group">
          <label for="display_name">Display Name // 昵称</label>
          <input type="text" id="display_name" maxlength="50" placeholder="Enter your display name" />
        </div>

        <div class="form-group">
          <label for="avatar_url">Avatar Source // 头像 URL</label>
          <input type="url" id="avatar_url" maxlength="500" placeholder="https://example.com/avatar.jpg" />
          <span class="input-hint">Enter a direct link to an image. HTTPS required.</span>
        </div>

        <div class="settings-actions">
           <button type="button" id="back-btn" class="btn-secondary btn-auto">返回</button>
           <button type="submit" id="save-btn" class="btn-auto" style="min-width: 140px;">保存修改</button>
        </div>
      </form>
    </div>
    
    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
  `;

  const avatarPreviewBox = document.getElementById('avatar-preview-box');
  
  function renderInitials(username) {
      avatarPreviewBox.innerHTML = ''; // Clear
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

      // Basic URL validation
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

      // Show loading state
      avatarPreviewBox.innerHTML = '';
      const loadingSpan = document.createElement('span');
      loadingSpan.className = 'initials';
      loadingSpan.style.opacity = '0.5';
      loadingSpan.innerText = '...';
      avatarPreviewBox.appendChild(loadingSpan);

      // Create temp image to test load
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

  // Back button handler
  document.getElementById('back-btn').addEventListener('click', () => {
      navigate('/dashboard');
  });

  // Load user info
  let currentUser = {}; // Store for reference
  
  try {
    const user = await api.get('/auth/me', {
      headers: api.getAuthHeaders()
    });
    currentUser = user;

    document.getElementById('username').value = user.username;
    document.getElementById('email').value = user.email;
    document.getElementById('display_name').value = user.display_name || '';
    document.getElementById('avatar_url').value = user.avatar_url || '';
    
    // Update Display Elements
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

  // Handle live preview with debounce
  const avatarInput = document.getElementById('avatar_url');
  let previewTimeout;
  avatarInput.addEventListener('input', (e) => {
      clearTimeout(previewTimeout);
      previewTimeout = setTimeout(() => {
          const username = currentUser.username || '??';
          updateAvatarPreview(e.target.value.trim(), username);
      }, 500);
  });

  // Handle form submission
  const form = document.getElementById('settings-form');
  const saveBtn = document.getElementById('save-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoading(saveBtn, true);

    const displayName = document.getElementById('display_name').value.trim();
    const avatarUrl = document.getElementById('avatar_url').value.trim();

    try {
      const updateData = {};
      if (displayName) updateData.display_name = displayName;
      if (avatarUrl) {
          // Validate URL before submitting
          try {
              const urlObj = new URL(avatarUrl);
              if (urlObj.protocol !== 'https:') {
                  showError('头像 URL 必须使用 HTTPS 协议');
                  setLoading(saveBtn, false);
                  return;
              }
              updateData.avatar_url = avatarUrl;
          } catch {
              showError('请输入有效的 URL 地址');
              setLoading(saveBtn, false);
              return;
          }
      }

      await api.put('/auth/profile', updateData, {
        headers: api.getAuthHeaders()
      });

      showSuccess('资料更新成功 // PROFILE UPDATED');

      // Update local cache
      currentUser.display_name = displayName || currentUser.display_name;
      currentUser.avatar_url = avatarUrl || currentUser.avatar_url;

    } catch (error) {
      showError(error.message || '更新失败，请重试');
    } finally {
      setLoading(saveBtn, false);
    }
  });
}
