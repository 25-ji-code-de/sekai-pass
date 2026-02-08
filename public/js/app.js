import { APIClient, getQueryParams } from './utils.js';
import { renderLogin } from './pages/login.js';
import { renderRegister } from './pages/register.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderAuthorize } from './pages/authorize.js';

const api = new APIClient('/api');
const app = document.getElementById('app');

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

  if (!token && !publicRoutes.includes(path)) {
    window.history.pushState({}, '', '/login');
    renderLogin(app, api, navigate);
    return;
  }

  if (token && publicRoutes.includes(path)) {
    window.history.pushState({}, '', '/');
    renderDashboard(app, api, navigate);
    return;
  }

  route(app, api, navigate);
}

// Handle browser back/forward
window.addEventListener('popstate', render);

// Initial render
render();

// Export for global access
window.navigate = navigate;
window.api = api;
