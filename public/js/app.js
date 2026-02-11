import { APIClient, getQueryParams } from './utils.js';
import { renderLogin } from './pages/login.js';
import { renderRegister } from './pages/register.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderAuthorize } from './pages/authorize.js';

const api = new APIClient('/api');
const app = document.getElementById('app');

// Load token from localStorage on startup
const token = localStorage.getItem('token');
if (token) {
  api.setAuthToken(token);
}

// Load configuration from API
async function loadConfig() {
  try {
    const config = await api.get('/config');
    window.TURNSTILE_SITE_KEY = config.turnstile_site_key;
  } catch (error) {
    console.error('Failed to load config:', error);
    // Use default test key if config fails to load
    window.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  }
}

// Simple router
const routes = {
  '/': renderDashboard,
  '/login': renderLogin,
  '/register': renderRegister,
  '/oauth/authorize': renderAuthorize,
};

function navigate(path) {
  window.history.pushState({}, '', path);
  render();
}

function render() {
  const path = window.location.pathname;
  const route = routes[path] || routes['/'];

  // Check authentication for protected routes
  const token = localStorage.getItem('token');
  const publicRoutes = ['/login', '/register'];

  // Check for redirect parameter (for all routes when logged in)
  if (token) {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');

    if (redirect) {
      // Redirect to the specified path
      window.history.pushState({}, '', redirect);
      render();
      return;
    }

    // If on public routes, redirect to dashboard
    if (publicRoutes.includes(path)) {
      window.history.pushState({}, '', '/');
      renderDashboard(app, api, navigate);
      return;
    }
  }

  if (!token && !publicRoutes.includes(path)) {
    // Save current path as redirect parameter
    const redirectPath = path + window.location.search;
    window.history.pushState({}, '', `/login?redirect=${encodeURIComponent(redirectPath)}`);
    renderLogin(app, api, navigate);
    return;
  }

  route(app, api, navigate);
}

// Handle browser back/forward
window.addEventListener('popstate', render);

// Load config and initial render
loadConfig().then(() => {
  render();
});

// Export for global access
window.navigate = navigate;
window.api = api;
