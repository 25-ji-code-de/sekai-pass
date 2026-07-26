// SPDX-License-Identifier: Apache-2.0
/**
 * Shared captcha orchestrator for login/register.
 *
 * Strategy: race, don't fail over. Turnstile mounts normally; if it has not
 * produced a token shortly after mount (or errors even once), a PoW solve
 * starts silently in a Web Worker while the user is still typing. Submission
 * takes whichever proof is ready, preferring Turnstile. The UI only changes
 * when Turnstile is truly dead — and by then PoW is usually already solved,
 * so the swap shows a success mark instead of a spinner.
 *
 * Browsers where Turnstile recently failed (localStorage marker, 24h) start
 * the PoW solve immediately, so repeat visitors on blocked networks never
 * wait at all. Whether PoW is available, and at what difficulty, is decided
 * server-side per region — the client only ever asks.
 */

import { mountTurnstile } from './turnstile-helper.js';
import { solvePoW } from './pow-solver.js';

/** How long Turnstile gets to deliver on its own before PoW starts alongside. */
const RACE_DELAY_MS = 3500;
const FAIL_MARKER_KEY = 'sekai:turnstile-failed-at';
const FAIL_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

function turnstileRecentlyFailed() {
  try {
    const at = parseInt(localStorage.getItem(FAIL_MARKER_KEY) || '', 10);
    return Number.isFinite(at) && Date.now() - at < FAIL_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

function markTurnstileFailed() {
  try {
    localStorage.setItem(FAIL_MARKER_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

function clearTurnstileFailed() {
  try {
    localStorage.removeItem(FAIL_MARKER_KEY);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   api: { get: (p: string) => Promise<any>, post: (p: string, body: any) => Promise<any> },
 *   sitekey: string,
 *   widgetEl: HTMLElement,
 *   statusEl: HTMLElement,
 *   theme?: string,
 * }} opts
 * @returns {{
 *   getProof: (waitMs?: number) => Promise<
 *     | { ok: true, type: 'turnstile' | 'pow', token?: string, nonce?: string, challengeId: string }
 *     | { ok: false, reason: 'interactive' | 'not-ready' | 'failed' }
 *   >,
 *   refreshAfterFailure: () => Promise<void>,
 *   destroy: () => void,
 * }}
 */
export function createCaptcha({ api, sitekey, widgetEl, statusEl, theme = 'dark' }) {
  let destroyed = false;
  /** Bumped on refresh/destroy so stale async results discard themselves. */
  let gen = 0;
  let challengeId = null;
  /** @type {null | { challenge: string, difficulty: number }} */
  let powParams = null;
  let powNonce = null;
  /** @type {Promise<void> | null} */
  let powPromise = null;
  let powFailed = false;
  /** @type {null | Awaited<ReturnType<typeof mountTurnstile>>} */
  let widget = null;
  let widgetDead = false;
  let raceTimer = null;

  function showStatus(kind, text) {
    if (destroyed) return;
    statusEl.style.display = 'flex';
    if (kind === 'pending') {
      statusEl.className = 'pow-status';
      statusEl.innerHTML = '<div class="pow-spinner"></div><span></span>';
    } else {
      statusEl.className = kind === 'success' ? 'pow-status success' : 'pow-status error';
      statusEl.innerHTML = `<span class="pow-icon">${kind === 'success' ? '✓' : '✕'}</span><span></span>`;
    }
    statusEl.querySelector('span:last-child').textContent = text;
  }

  async function challengeInit() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await api.get('/challenge/init');
        challengeId = r.challengeId;
        powParams = r.pow || null;
        return true;
      } catch (err) {
        console.error('[captcha] challenge init failed:', err);
        if (attempt === 0) await sleep(1500);
      }
    }
    return false;
  }

  function armRaceTimer() {
    if (raceTimer != null) clearTimeout(raceTimer);
    raceTimer = setTimeout(() => {
      raceTimer = null;
      // Covers a widget that hasn't delivered AND a script load still stuck —
      // on blocked networks the api.js request itself can hang for many
      // seconds, and that wait must not delay the PoW race.
      if (!destroyed && !(widget && widget.getToken())) void ensurePow('race-delay');
    }, RACE_DELAY_MS);
  }

  async function ensurePow(reason) {
    if (destroyed || powNonce || powPromise || powFailed) return;
    const g = gen;
    console.info('[captcha] starting background PoW:', reason);
    powPromise = (async () => {
      try {
        if (!powParams) {
          // Server decides whether this region/IP gets PoW, and how expensive.
          const r = await api.post('/challenge/report', { challengeId, turnstileLoaded: false });
          if (g !== gen || destroyed) return;
          powParams = { challenge: r.challenge, difficulty: r.difficulty };
        }
        const nonce = await solvePoW(powParams.challenge, powParams.difficulty);
        if (g !== gen || destroyed) return;
        powNonce = nonce;
        if (widgetDead) showStatus('success', '环境验证已通过');
      } catch (err) {
        if (g !== gen || destroyed) return;
        console.error('[captcha] PoW failed:', err);
        powFailed = true;
        if (widgetDead) showStatus('error', (err && err.message) || '人机验证失败，请刷新重试');
      } finally {
        if (g === gen) powPromise = null;
      }
    })();
    return powPromise;
  }

  function handleWidgetFatal() {
    if (destroyed || widgetDead) return;
    widgetDead = true;
    markTurnstileFailed();
    if (raceTimer != null) {
      clearTimeout(raceTimer);
      raceTimer = null;
    }
    const dead = widget;
    widget = null;
    try {
      dead?.remove();
    } catch {
      /* ignore */
    }
    widgetEl.style.display = 'none';
    if (powNonce) {
      showStatus('success', '环境验证已通过');
    } else if (powFailed) {
      showStatus('error', '人机验证失败，请刷新重试');
    } else {
      showStatus('pending', '正在验证环境安全...');
      void ensurePow('widget-fatal');
    }
  }

  async function init() {
    const ok = await challengeInit();
    if (destroyed) return;
    if (!ok) {
      showStatus('error', '验证初始化失败，请刷新重试');
      return;
    }

    // Known-bad network for Turnstile → start solving right away, in parallel
    // with one more (free) attempt at the real widget.
    if (turnstileRecentlyFailed()) void ensurePow('remembered-failure');

    // Arm before mounting: the race clock must include script-load time.
    armRaceTimer();

    const mounted = await mountTurnstile(widgetEl, {
      sitekey,
      theme,
      onToken: () => clearTurnstileFailed(),
      onError: () => void ensurePow('widget-error'),
      onFatal: () => handleWidgetFatal(),
    });
    if (destroyed) {
      try {
        mounted?.remove();
      } catch {
        /* ignore */
      }
      return;
    }
    widget = mounted;
    if (widgetDead || !widget || widget.hadFatalError()) {
      try {
        mounted?.remove();
      } catch {
        /* ignore */
      }
      widget = null;
      handleWidgetFatal();
      return;
    }
  }

  let initPromise = init();

  async function getProof(waitMs = 8000) {
    try {
      await initPromise;
    } catch {
      /* ignore */
    }
    if (destroyed || !challengeId) return { ok: false, reason: 'failed' };

    // The user is waiting now — if Turnstile hasn't delivered yet, stop being
    // polite about CPU and start PoW immediately.
    if (!(widget && widget.getToken()) && !powNonce) void ensurePow('submit');

    const start = Date.now();
    for (;;) {
      const token = widget ? widget.getToken() : null;
      if (token) return { ok: true, type: 'turnstile', token, challengeId };
      if (powNonce) return { ok: true, type: 'pow', nonce: powNonce, challengeId };
      if (widget && widget.isInteractive() && !powPromise) {
        return { ok: false, reason: 'interactive' };
      }
      if (!widget && !powPromise) {
        return { ok: false, reason: powFailed ? 'failed' : 'not-ready' };
      }
      if (Date.now() - start > waitMs) return { ok: false, reason: 'not-ready' };
      await sleep(120);
    }
  }

  // Challenges are single-use server-side: after any rejected submission a
  // fresh challengeId (and proof) is required.
  async function refreshAfterFailure() {
    if (destroyed) return;
    gen += 1;
    powNonce = null;
    powParams = null;
    powFailed = false;
    powPromise = null;
    initPromise = (async () => {
      const ok = await challengeInit();
      if (destroyed) return;
      if (!ok) {
        showStatus('error', '验证初始化失败，请刷新重试');
        return;
      }
      if (widget && !widgetDead && !widget.hadFatalError()) {
        try {
          widget.reset();
          armRaceTimer();
        } catch {
          handleWidgetFatal();
        }
      } else {
        showStatus('pending', '正在验证环境安全...');
        void ensurePow('refresh');
      }
    })();
    await initPromise;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    gen += 1;
    if (raceTimer != null) {
      clearTimeout(raceTimer);
      raceTimer = null;
    }
    try {
      widget?.remove();
    } catch {
      /* ignore */
    }
    widget = null;
  }

  return { getProof, refreshAfterFailure, destroy };
}
