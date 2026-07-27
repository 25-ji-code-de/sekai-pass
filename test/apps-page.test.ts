/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 开放平台那一屏的行为测试 —— 真的把 `renderApps` 跑起来。
 *
 * 为什么不满足于静态扫描：我在这一版里写下过
 *
 *     const app = state.apps.find(...)   // state 根本不存在
 *     if (app) manageKeys(app);          // manageKeys 也不存在
 *
 * 两个名字都不存在，`node --check` 全过、静态扫描也全过 —— 因为语法没错，
 * 只是运行到那一行才 ReferenceError。而那一行只在「切成机密客户端且没有
 * 公钥」这条支路上才会走到，正常点几下页面根本碰不到。
 *
 * 所以这里用一个最小 DOM 桩把代码**跑一遍**。桩不追求完整，只要能让
 * `innerHTML` 里的 id 能被 `getElementById` 找回来、事件能被点到即可。
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error —— 浏览器端 ES 模块，没有类型声明
import { renderApps } from "../public/js/pages/apps.js";

// ── 最小 DOM 桩 ───────────────────────────────────────────────────

interface StubEl {
  id: string;
  dataset: Record<string, string>;
  value: string;
  disabled: boolean;
  className: string;
  textContent: string;
  style: Record<string, string>;
  innerHTML: string;
  addEventListener(type: string, fn: () => unknown): void;
  click(): Promise<void>;
  querySelectorAll(sel: string): StubEl[];
  querySelector(sel: string): StubEl | null;
}

let registry: Map<string, StubEl>;
/** innerHTML 被写入过的全部文本，按写入顺序。 */
let written: string[];

function makeEl(id = ""): StubEl {
  const listeners = new Map<string, Array<() => unknown>>();
  let html = "";
  const el: StubEl = {
    id,
    dataset: {},
    value: "",
    disabled: false,
    className: "",
    textContent: "",
    // setLoading 会写 style.display
    style: {} as Record<string, string>,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      written.push(v);
      // 把新写进去的 id 注册成可被 getElementById 找到的元素
      for (const m of v.matchAll(/id="([^"]+)"/g)) {
        if (!registry.has(m[1])) registry.set(m[1], makeEl(m[1]));
      }
    },
    addEventListener(type, fn) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    async click() {
      // 提交处理器用 e.currentTarget 来 setLoading，事件对象不能省
      const event = { currentTarget: el, target: el, preventDefault() {} };
      for (const fn of listeners.get("click") ?? []) await (fn as (e: unknown) => unknown)(event);
    },
    /*
     * 只认 `[data-action]` —— 应用卡片上的按钮就是靠它绑事件的。
     * 桩把最近一次写进本元素的 innerHTML 里的 `data-action=... data-client-id=...`
     * 解析出来，造成对应的元素，这样测试才能真的「点」到编辑/管理公钥。
     */
    querySelectorAll(sel: string) {
      const found: StubEl[] = [];

      /*
       * 每次都造**新**元素，不复用缓存里的。
       *
       * 第一版按 `动作:id` 缓存了按钮对象，结果每次 loadKeys 重渲染都往
       * 同一个对象上再挂一个监听器；点一次触发全部累积的监听器，每个又
       * 触发一次 loadKeys —— 指数级增长，测试跑到堆溢出。
       *
       * 真实 DOM 里 innerHTML 一写，旧节点连同监听器一起没了。桩要照这个来。
       */
      if (sel === "[data-action]") {
        for (const m of html.matchAll(
          /data-action="([^"]+)"\s+data-client-id="([^"]+)"/g,
        )) {
          const btn = makeEl();
          btn.dataset = { action: m[1], clientId: m[2] };
          actionButtons.set(`${m[1]}:${m[2]}`, btn);
          found.push(btn);
        }
        return found;
      }

      if (sel === "[data-key-action]") {
        // 公钥行的按钮，两个属性跨行写
        for (const m of html.matchAll(
          /data-key-action="([^"]+)"[^>]*?data-key-id="([^"]+)"/g,
        )) {
          const btn = makeEl();
          btn.dataset = { keyAction: m[1], keyId: m[2] };
          keyButtons.set(`${m[1]}:${m[2]}`, btn);
          found.push(btn);
        }
        return found;
      }

      return found;
    },
    querySelector() {
      return null;
    },
  };
  return el;
}

/** `动作:clientId` -> 按钮，测试用它来「点击」。 */
let actionButtons: Map<string, StubEl>;
/** `公钥动作:keyId` -> 按钮。 */
let keyButtons: Map<string, StubEl>;
/** window.confirm 收到的全部提示文本，以及下一次要返回什么。 */
let confirms: string[];
let confirmAnswer: boolean;

function setupDom() {
  registry = new Map();
  written = [];
  actionButtons = new Map();
  keyButtons = new Map();
  confirms = [];
  confirmAnswer = true;
  (globalThis as any).window = {
    confirm(msg: string) {
      confirms.push(msg);
      return confirmAnswer;
    },
  };
  (globalThis as any).document = {
    getElementById(id: string) {
      if (!registry.has(id)) registry.set(id, makeEl(id));
      return registry.get(id)!;
    },
    querySelector() {
      return makeEl();
    },
  };
  (globalThis as any).localStorage = {
    getItem: () => "session-token",
    setItem: () => {},
  };
  (globalThis as any).navigator ??= {};
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
}

/** 记录调用的假 api。 */
function makeApi(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = {
    calls,
    setAuthToken() {},
    getAuthHeaders: () => ({}),
    async get(path: string) {
      calls.push({ method: "GET", path });
      if (path === "/apps") {
        return { applications: (overrides.apps as unknown[]) ?? [], limit: 20 };
      }
      if (path.endsWith("/keys")) {
        if (overrides.keysThrows) throw new Error("boom");
        return { keys: (overrides.keys as unknown[]) ?? [] };
      }
      return {};
    },
    async put(path: string, body: unknown) {
      calls.push({ method: "PUT", path, body });
      return { application: { ...(overrides.savedApp as object) } };
    },
    async post(path: string, body: unknown) {
      calls.push({ method: "POST", path, body });
      return { application: overrides.savedApp };
    },
    // patch / delete 必须也记账：不记的话「点了取消就什么都不发」
    // 这条断言会永远成立 —— 一个空测。
    async patch(path: string, body: unknown) {
      calls.push({ method: "PATCH", path, body });
      return {};
    },
    async delete(path: string) {
      calls.push({ method: "DELETE", path });
      return {};
    },
  };
  return api;
}

const PUBLIC_APP = {
  client_id: "app_abc",
  name: "测试应用",
  redirect_uris: ["https://example.test/cb"],
  token_endpoint_auth_method: "none",
  created_at: 1700000000000,
};

/** 点应用卡片上的某个动作按钮。 */
async function clickAction(action: string, clientId: string) {
  const btn = actionButtons.get(`${action}:${clientId}`);
  assert.ok(btn, `找不到「${action}」按钮（clientId=${clientId}）`);
  await btn!.click();
}

/**
 * 完整走一遍「编辑 → 把认证方式改成 private_key_jwt → 保存」。
 *
 * 这就是那条只有走到才会暴露 ReferenceError 的支路。
 */
async function editToConfidential(api: ReturnType<typeof makeApi>) {
  await renderApps(document.getElementById("app"), api, () => {});
  await clickAction("edit", PUBLIC_APP.client_id);

  document.getElementById("f-name").value = PUBLIC_APP.name;
  document.getElementById("f-uris").value = PUBLIC_APP.redirect_uris.join("\n");
  document.getElementById("f-method").value = "private_key_jwt";

  written.length = 0;
  await document.getElementById("f-submit").click();
  return written.join("\n");
}

describe("开放平台：切成机密客户端时的提醒", () => {
  beforeEach(setupDom);

  test("页面能渲染（桩够用）", async () => {
    const api = makeApi({ apps: [PUBLIC_APP] });
    await renderApps(document.getElementById("app"), api, () => {});
    assert.ok(
      written.some((h) => h.includes("apps-list")),
      "没有渲染出应用列表容器",
    );
    assert.ok(
      api.calls.some((c) => c.method === "GET" && c.path === "/apps"),
      "没有去取应用列表",
    );
  });

  test("没有 token 时跳登录，不发任何请求", async () => {
    (globalThis as any).localStorage.getItem = () => null;
    const api = makeApi();
    let to = "";
    await renderApps(document.getElementById("app"), api, (p: string) => {
      to = p;
    });
    assert.equal(to, "/login");
    assert.deepEqual(api.calls, []);
  });

  test("列表为空时给的是空状态，不是报错", async () => {
    const api = makeApi({ apps: [] });
    await renderApps(document.getElementById("app"), api, () => {});
    assert.ok(written.some((h) => h.includes("还没有应用")));
  });

  test("切成机密客户端且没有公钥 —— 提醒会出现", async () => {
    const api = makeApi({
      apps: [PUBLIC_APP],
      keys: [],
      savedApp: { ...PUBLIC_APP, token_endpoint_auth_method: "private_key_jwt" },
    });
    const out = await editToConfidential(api);

    assert.match(out, /还没有登记任何公钥/, "没有提醒");
    assert.match(out, /取不到 token/, "没有说清后果");
    assert.ok(
      api.calls.some((c) => c.method === "PUT"),
      "根本没保存",
    );
  });

  test("「去登记公钥」按钮真的能跳到公钥管理", async () => {
    /*
     * 这一条正是这批测试的由来。原来这里写的是
     *   const app = state.apps.find(...); if (app) manageKeys(app);
     * 两个名字都不存在 —— 语法没错，只有点下这个按钮才 ReferenceError。
     */
    const api = makeApi({
      apps: [PUBLIC_APP],
      keys: [],
      savedApp: { ...PUBLIC_APP, token_endpoint_auth_method: "private_key_jwt" },
    });
    await editToConfidential(api);

    written.length = 0;
    await document.getElementById("warn-goto-keys").click();

    assert.ok(
      api.calls.some((c) => c.path.endsWith("/keys") && c.method === "GET"),
      "没有去取公钥列表 —— 按钮没真的跳过去",
    );
    assert.match(written.join("\n"), /公钥|keys-list/, "没有渲染公钥管理面板");
  });

  test("已经有可用公钥时不提醒（不唠叨）", async () => {
    const api = makeApi({
      apps: [PUBLIC_APP],
      keys: [{ key_id: "k1", status: "active" }],
      savedApp: { ...PUBLIC_APP, token_endpoint_auth_method: "private_key_jwt" },
    });
    const out = await editToConfidential(api);
    assert.doesNotMatch(out, /还没有登记任何公钥/);
  });

  test("只剩已吊销的公钥时仍然提醒", async () => {
    // 按「列表非空」判断的话这里会漏掉 —— 而这个应用确实取不到 token
    const api = makeApi({
      apps: [PUBLIC_APP],
      keys: [{ key_id: "k1", status: "revoked" }],
      savedApp: { ...PUBLIC_APP, token_endpoint_auth_method: "private_key_jwt" },
    });
    const out = await editToConfidential(api);
    assert.match(out, /还没有登记任何公钥/);
  });

  test("查公钥失败时也提醒（宁可多说一句）", async () => {
    const api = makeApi({
      apps: [PUBLIC_APP],
      keysThrows: true,
      savedApp: { ...PUBLIC_APP, token_endpoint_auth_method: "private_key_jwt" },
    });
    const out = await editToConfidential(api);
    assert.match(out, /还没有登记任何公钥/);
  });

  test("本来就是机密客户端，改别的字段不提醒", async () => {
    const confidential = {
      ...PUBLIC_APP,
      token_endpoint_auth_method: "private_key_jwt",
    };
    const api = makeApi({ apps: [confidential], keys: [], savedApp: confidential });
    await renderApps(document.getElementById("app"), api, () => {});
    await clickAction("edit", confidential.client_id);
    document.getElementById("f-name").value = "改个名";
    document.getElementById("f-uris").value = "https://example.test/cb";
    document.getElementById("f-method").value = "private_key_jwt";
    written.length = 0;
    await document.getElementById("f-submit").click();
    assert.doesNotMatch(written.join("\n"), /还没有登记任何公钥/);
  });

  test("应用名里的尖括号被转义（列表是拼 innerHTML 的）", async () => {
    const api = makeApi({
      apps: [{ ...PUBLIC_APP, name: '<img src=x onerror=alert(1)>' }],
    });
    await renderApps(document.getElementById("app"), api, () => {});
    const all = written.join("\n");
    assert.ok(
      !all.includes("<img src=x"),
      "应用名原样进了 innerHTML —— 存储型 XSS",
    );
    assert.ok(all.includes("&lt;img"), "没有看到转义后的形式");
  });
});

describe("公钥管理：撤销/删除最后一把时的确认语", () => {
  beforeEach(setupDom);

  const CONFIDENTIAL = {
    ...PUBLIC_APP,
    token_endpoint_auth_method: "private_key_jwt",
  };
  const key = (id: string, status = "active") => ({
    key_id: id,
    algorithm: "ES256",
    status,
    created_at: 1700000000000,
  });

  /** 渲染 -> 点「管理公钥」-> 点某把 key 上的某个动作。 */
  async function actOnKey(
    keys: unknown[],
    action: string,
    keyId: string,
  ): Promise<ReturnType<typeof makeApi>> {
    const api = makeApi({ apps: [CONFIDENTIAL], keys });
    await renderApps(document.getElementById("app"), api, () => {});
    await clickAction("keys", CONFIDENTIAL.client_id);
    const btn = keyButtons.get(`${action}:${keyId}`);
    assert.ok(btn, `找不到公钥按钮 ${action}:${keyId}`);
    await btn!.click();
    return api;
  }

  test("删除最后一把 —— 确认语说清整个应用会停", async () => {
    await actOnKey([key("k1")], "delete", "k1");
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /最后一把生效中的公钥/);
    assert.match(confirms[0], /取不到任何 token/);
    assert.match(confirms[0], new RegExp(CONFIDENTIAL.name), "得指名是哪个应用");
  });

  test("删除其中一把（还有别的生效中）—— 不说「最后一把」", async () => {
    await actOnKey([key("k1"), key("k2")], "delete", "k1");
    assert.equal(confirms.length, 1);
    assert.doesNotMatch(confirms[0], /最后一把/);
  });

  test("已撤销的那把不算数：只剩一把生效中时仍然警告", async () => {
    await actOnKey([key("k1"), key("k2", "revoked")], "delete", "k1");
    assert.match(confirms[0], /最后一把生效中的公钥/);
  });

  test("撤销最后一把也要确认（原来撤销完全不问）", async () => {
    const api = await actOnKey([key("k1")], "revoke", "k1");
    assert.equal(confirms.length, 1, "撤销最后一把时没有确认");
    assert.match(confirms[0], /最后一把生效中的公钥/);
    assert.ok(api.calls.some((c) => c.method === "PATCH"));
  });

  test("撤销其中一把不打断（撤销可逆，平时不该问）", async () => {
    await actOnKey([key("k1"), key("k2")], "revoke", "k1");
    assert.deepEqual(confirms, [], "撤销非最后一把时不该弹确认");
  });

  test("在确认框上点取消 —— 什么请求都不发", async () => {
    confirmAnswer = false;
    const api = makeApi({ apps: [CONFIDENTIAL], keys: [key("k1")] });
    await renderApps(document.getElementById("app"), api, () => {});
    await clickAction("keys", CONFIDENTIAL.client_id);
    api.calls.length = 0;
    await keyButtons.get("delete:k1")!.click();
    assert.deepEqual(
      api.calls.filter((c) => c.method !== "GET"),
      [],
      "点了取消却还是发了请求",
    );
  });

  test("恢复一把已撤销的不弹确认", async () => {
    await actOnKey([key("k1", "revoked")], "activate", "k1");
    assert.deepEqual(confirms, []);
  });
});

describe("hasNoActiveKey / warnMissingKey 的判断", () => {
  /*
   * 这两个函数是闭包，测不到内部；但它们的**判断依据**必须写在源码里，
   * 而且必须是「没有 active 的就算没有」而不是「一个 key 都没有才算没有」——
   * 已吊销的 key 留在列表里，按后者判断会漏掉。
   */
  const src = readSource();

  test("按 status === 'active' 判断，而不是按列表非空", () => {
    assert.match(
      src,
      /\.some\(\(k\) => k\.status === 'active'\)/,
      "没有按 active 状态判断 —— 只剩已吊销的 key 时会误判为「有公钥」",
    );
  });

  test("查询失败时按「没有公钥」处理（宁可多提示一句）", () => {
    const fn = /async function hasNoActiveKey[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
    assert.ok(fn, "找不到 hasNoActiveKey");
    assert.match(
      fn,
      /catch\s*\{\s*return true;/,
      "查询失败时应当按「没有公钥」处理",
    );
  });

  test("只在 none -> private_key_jwt 这个方向上提醒", () => {
    // 反方向（机密改公开）不需要登记公钥，提醒就是噪音
    assert.match(src, /const wasPublic = existing\.token_endpoint_auth_method !== 'private_key_jwt'/);
    assert.match(src, /const nowConfidential = payload\.token_endpoint_auth_method === 'private_key_jwt'/);
    assert.match(src, /if \(wasPublic && nowConfidential && \(await hasNoActiveKey\(/);
  });

  test("提醒里说清了后果", () => {
    const fn = /function warnMissingKey[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
    assert.match(fn, /取不到 token/, "得说清楚后果，不能只说「请登记公钥」");
    assert.match(fn, /showKeys\(app\)/, "「去登记公钥」得真的能跳过去");
  });

  test("warnMissingKey 里引用的名字都真的存在", () => {
    /*
     * 这一条是这批测试的由来。原来这里写的是 state.apps.find(...) 与
     * manageKeys(app)，两个名字都不存在 —— 语法没错，只有走到那条支路
     * 才 ReferenceError。
     */
    const fn = /function warnMissingKey[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
    for (const m of fn.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (["if", "for", "while", "switch", "catch", "function", "return"].includes(name)) continue;
      const declared =
        new RegExp(`function ${name}\\b`).test(src) ||
        new RegExp(`(const|let|var) ${name}\\b`).test(src) ||
        new RegExp(`import \\{[^}]*\\b${name}\\b`).test(src);
      const builtin = [
        "escapeHtml", "getElementById", "addEventListener", "querySelector",
        "encodeURIComponent", "String", "Number", "Boolean",
      ].includes(name);
      assert.ok(
        declared || builtin,
        `warnMissingKey 里调用了 ${name}()，但源码里找不到它的定义`,
      );
    }
  });
});

function readSource(): string {
  return readFileSync(
    join(import.meta.dirname, "..", "public/js/pages/apps.js"),
    "utf8",
  );
}
