/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设计 token 的回归测试。
 *
 * 本仓的调色板从写死的 hex 改成了从 sekai-design 的 contract token 派生。
 * 这类迁移最容易出的事故是**悄悄改了颜色** —— 差一个字节没人看得出来，
 * 但线上就是变了。所以这里把迁移前的原始取值逐个钉死，用计算值比对。
 *
 * 另一件要钉的事：新写的组件样式不许再回退到裸 hex 或旧别名。
 * 设计系统的规则是"组件只引用 contract 里的名字"，没有强制手段的话
 * 这条规则活不过三次改动。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * vendored 的四个 token 文件，与上游 `sekai-design/tokens/` 一一对应。
 *
 * 分开放而不是拼成一个文件：`@sekai-vendor` 的漂移检查是
 * 「一个文件 ↔ 一个上游路径」，拼接之后没法逐字比对 —— 而那正是
 * vendored 的全部意义。（拼接版还会让 stylelint 报
 * no-duplicate-selectors，因为四个上游文件各有自己的 `:root`。）
 */
const LAYERS = ['primitives', 'contract', 'world-system', 'world-night'] as const;
const layer: Record<string, string> = Object.fromEntries(
  LAYERS.map((name) => [name, readFileSync(join(root, 'public/css/sekai/' + name + '.css'), 'utf8')]),
);
/** 需要「在四层里任意一层找」时用。 */
const tokens = LAYERS.map((n) => layer[n]).join('\n');

const styles = readFileSync(join(root, 'public/css/styles.css'), 'utf8');

/** 读一个 `--name: value;` 声明（取第一处定义）。 */
function tokenValue(css: string, name: string): string | null {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : null;
}

const hexOf = (triplet: string): string =>
  '#' +
  triplet
    .trim()
    .split(/\s+/)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('');

/** 取某个选择器块里定义的全部 `--name: value`。 */
function blockTokens(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)[^\\n{}]*${escaped}[^\\n{}]*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  const out = new Map<string, string>();
  if (!m) return out;
  for (const d of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(d[1], d[2].trim().replace(/\s*\/\*[\s\S]*$/, '').trim());
  }
  return out;
}

describe('vendored 的 token 文件', () => {
  test('四个文件与上游 tokens/ 一一对应', () => {
    assert.match(layer.primitives, /Layer 0: Primitives/);
    assert.match(layer.contract, /Layer 1: The semantic contract/);
    assert.match(layer['world-system'], /World: SYSTEM/i);
    assert.match(layer['world-night'], /World: NIGHT/i);
  });

  for (const name of LAYERS) {
    test(`${name}.css 记了上游 commit 与来源文件`, () => {
      // 只看文件头，失败时不把整份 CSS 打进日志
      const header = layer[name].slice(0, 800);
      assert.ok(
        new RegExp(`tokens/${name}\\.css\\s*@\\s*[0-9a-f]{7,}`).test(header),
        '头部没写清楚对应哪个上游文件、哪个 commit',
      );
      // 上游正在开发，工作区随时和任何一个 commit 都对不上；
      // 标了 commit 却抄工作区，这行出处比没有还坏
      assert.match(header, /提交树/, '没说明取自提交树而非工作区');
      assert.match(header, /不要在这里改任何值/);
    });
  }

  test('两个 world 都是类作用域', () => {
    /*
     * world-night 排在 world-system 之后加载。它要是写成裸 :root，
     * 本仓（world-system）就会被整个盖掉 —— 而且不会有任何报错，
     * 只是颜色全变了。
     */
    for (const name of ['world-system', 'world-night']) {
      const selectors = [...layer[name].matchAll(/\n([^\n{}]+)\{/g)].map((m) => m[1].trim());
      assert.ok(selectors.length > 0, `${name}.css 里找不到选择器`);
      for (const s of selectors) {
        if (s.startsWith('@')) continue; // @media 之类
        assert.match(s, /\.world-(system|night)/, `${name}.css 有非类作用域的选择器：${s}`);
      }
    }
  });

  test('contract 的 :root 兜底与 world-system 逐项一致', () => {
    /*
     * contract 的 :root 是"没挂任何 world class 时"的取值，注释里写明
     * 它就是 world-system。两者一旦分叉，同一个页面加不加
     * class="world-system" 会渲染成两个样子，而且不会有任何报错。
     */
    const fallback = blockTokens(layer.contract, ':root');
    const system = blockTokens(layer['world-system'], ':root.world-system');

    // 先确认两边都真的解析出东西了 —— 解析空了的话下面的比对就是空转。
    // 第一版就栽在这里：`:root` 匹配到了 primitives 那块（一个颜色都没有），
    // 改坏 world-system 的取值测试照样全绿，是反向验证抓到的。
    assert.ok(fallback.has('sekai-accent'), 'contract 的 :root 没解析出调色板');
    assert.ok(system.has('sekai-accent'), 'world-system 没解析出 --sekai-accent');

    const shared = [...system.keys()].filter((k) => fallback.has(k));
    assert.ok(shared.length > 10, `两边只有 ${shared.length} 个同名 token，比对不成立`);

    const mismatched = shared
      .filter((k) => fallback.get(k) !== system.get(k))
      .map((k) => `--${k}: 兜底 ${fallback.get(k)} ≠ world-system ${system.get(k)}`);
    assert.deepEqual(mismatched, []);
  });

  test('信号色只在 contract 里定义，两个世界不各来一份', () => {
    // contract 说得很直白：a system whose danger changes hue per theme
    // is two systems
    for (const t of ['sekai-danger', 'sekai-success', 'sekai-warning', 'sekai-info', 'sekai-signal']) {
      assert.ok(tokenValue(layer.contract, t), `contract.css 缺少 --${t}`);
      for (const name of ['world-system', 'world-night']) {
        assert.equal(
          tokenValue(layer[name], t),
          null,
          `${name}.css 重新定义了 --${t} —— 信号色按设计是跨世界一致的`,
        );
      }
    }
  });

  test('调色板 token 一律是空格分隔的三元组，没有 hex 孪生', () => {
    // contract 的核心规则：一个颜色只有一种拼写，两种拼写必然漂移
    const PALETTE = [
      'sekai-canvas', 'sekai-surface', 'sekai-surface-raised', 'sekai-surface-sunken',
      'sekai-surface-hover', 'sekai-line', 'sekai-line-strong', 'sekai-divider',
      'sekai-fg', 'sekai-fg-muted', 'sekai-fg-subtle', 'sekai-fg-on-accent',
      'sekai-accent', 'sekai-accent-hover', 'sekai-accent-deep', 'sekai-accent-fill',
      'sekai-signal', 'sekai-danger', 'sekai-success', 'sekai-warning', 'sekai-info',
      'sekai-scrim',
    ];
    for (const name of PALETTE) {
      const v = tokenValue(tokens, name);
      assert.ok(v, `缺少 --${name}`);
      assert.match(v!, /^\d{1,3} \d{1,3} \d{1,3}$/, `--${name} 不是三元组：${v}`);
    }
  });

  test('contract 引用的 primitive 都存在', () => {
    // contract 里 `var(--sekai-x)` 引到的名字必须在 Layer 0 有定义，
    // 否则整条声明静默失效，页面看起来"就是有点不对"
    for (const m of tokens.matchAll(/--sekai-(?:radius|tracking|weight)-[\w-]+/g)) {
      const name = m[0].slice(2);
      assert.ok(tokenValue(tokens, name), `contract 引用了未定义的 --${name}`);
    }
  });
});

describe('旧别名与迁移前的取值逐字相等', () => {
  /** 迁移前 styles.css 里写死的值。改这张表 = 改线上颜色。 */
  const BEFORE: Record<string, string> = {
    '--bg-color': '#0b0b0e',
    '--button-color': '#1a1a1e',
    '--card-bg': '#17171c',
    '--primary-color': '#a48cd6',
    '--primary-hover': '#bda6e8',
    '--text-main': '#e2e2e6',
    '--text-muted': '#75757a',
    '--border-color': '#2a2a30',
    '--gradient-bg': '#594483',
    '--input-bg': '#111114',
  };

  /** 别名 → 它现在派生自哪个 token。 */
  const DERIVES: Record<string, string> = {
    '--bg-color': 'sekai-canvas',
    '--button-color': 'sekai-fg-on-accent',
    '--card-bg': 'sekai-surface',
    '--primary-color': 'sekai-accent',
    '--primary-hover': 'sekai-accent-hover',
    '--text-main': 'sekai-fg',
    '--text-muted': 'sekai-fg-muted',
    '--border-color': 'sekai-line',
    '--gradient-bg': 'sekai-accent-deep',
    '--input-bg': 'sekai-surface-sunken',
  };

  for (const [alias, hex] of Object.entries(BEFORE)) {
    test(`${alias} 仍然是 ${hex}`, () => {
      const triplet = tokenValue(tokens, DERIVES[alias]);
      assert.ok(triplet, `token --${DERIVES[alias]} 不存在`);
      assert.equal(hexOf(triplet!), hex);
    });
  }

  test('三元组形式的别名直接透传，不做转换', () => {
    assert.equal(tokenValue(tokens, 'sekai-danger'), '229 115 115');
    assert.equal(tokenValue(tokens, 'sekai-success'), '129 199 132');
    assert.equal(tokenValue(styles, 'error-color'), 'var(--sekai-danger)');
    assert.equal(tokenValue(styles, 'success-color'), 'var(--sekai-success)');
    assert.equal(tokenValue(styles, 'primary-color-mix'), 'var(--sekai-accent)');
  });

  test('注释掉的主题示例也用 token 写 —— 不然照抄就是新造漂移点', () => {
    // 这些块现在是注释，但它们是"下一个人写新主题时照抄的模板"。
    // 模板里留着 hex 孪生写法，等于把已经修掉的问题埋回去。
    const themeBlocks = [
      /@media \(prefers-color-scheme: light\)[\s\S]*?\n\}/.exec(styles)?.[0],
      /\.theme-leo \{[\s\S]*?\n\}/.exec(styles)?.[0],
      /\.theme-vbs \{[\s\S]*?\n\}/.exec(styles)?.[0],
    ];
    for (const block of themeBlocks) {
      assert.ok(block, '找不到主题示例块');
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block!), `主题示例里还有裸 hex：${block}`);
      assert.ok(
        !/--primary-color-mix\s*:/.test(block!),
        '主题示例还在教人同时写 --primary-color 与 --primary-color-mix',
      );
      assert.match(block!, /--sekai-/, '主题示例应当改 contract token');
    }
  });

  test('每个别名都是从 token 派生的，没有漏网的 hex', () => {
    const block = /:root\s*\{([\s\S]*?)\}/.exec(styles)?.[1] ?? '';
    assert.ok(block, '找不到 :root 块');
    const literals = [...block.matchAll(/^\s*(--[\w-]+)\s*:\s*(#[0-9a-f]{3,8})/gim)];
    assert.deepEqual(
      literals.map((m) => `${m[1]}: ${m[2]}`),
      [],
      '这些别名还写着裸 hex，会与 token 漂移',
    );
  });
});

describe('新组件样式遵守设计系统', () => {
  /** 提取一个 CSS 选择器块的声明体。 */
  function ruleBody(selector: string): string {
    const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`);
    const m = re.exec(styles);
    assert.ok(m, `找不到规则 ${selector}`);
    return m![1];
  }

  const KEY_RULES = [
    '.key-list', '.key-row', '.key-row-main', '.key-row-meta', '.key-row-actions',
  ];

  test('公钥列表一律用 --sekai-* ，不用旧别名', () => {
    const LEGACY = /var\(--(?:card-bg|input-bg|border-color|text-main|text-muted|primary-color|code-font|error-color|success-color)\)/;
    for (const sel of KEY_RULES) {
      const body = ruleBody(sel);
      assert.ok(!LEGACY.test(body), `${sel} 用了旧别名：${body.trim()}`);
    }
  });

  test('公钥列表里没有裸 hex', () => {
    for (const sel of KEY_RULES) {
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(ruleBody(sel)), `${sel} 写了裸 hex`);
    }
  });

  test('用的都是真实存在的 token', () => {
    for (const sel of KEY_RULES) {
      for (const m of ruleBody(sel).matchAll(/var\((--sekai-[\w-]+)\)/g)) {
        const name = m[1].slice(2);
        assert.ok(tokenValue(tokens, name), `${sel} 引用了不存在的 ${m[1]}`);
      }
    }
  });

  test('Key ID 走 mono —— 设计系统里 mono 是"机器嗓音"', () => {
    assert.match(ruleBody('.key-row-main code'), /--sekai-font-mono/);
  });
});

describe('加载顺序', () => {
  /*
   * 四层必须按 primitives → contract → world 的顺序，且都排在 styles.css
   * 之前。顺序反了别名会读到空值，整页退化成浏览器默认色 —— 而且不报错。
   */
  for (const file of ['public/index.html', 'src/lib/html.ts']) {
    test(file, () => {
      const html = readFileSync(join(root, file), 'utf8');
      const at = LAYERS.map((name) => {
        const i = html.indexOf(`/css/sekai/${name}.css`);
        assert.ok(i >= 0, `没有引入 sekai/${name}.css`);
        return i;
      });
      for (let i = 1; i < at.length; i++) {
        assert.ok(at[i] > at[i - 1], `${LAYERS[i]}.css 必须排在 ${LAYERS[i - 1]}.css 之后`);
      }
      const stylesAt = html.indexOf('/css/styles.css');
      assert.ok(stylesAt >= 0, '没有引入 styles.css');
      assert.ok(Math.max(...at) < stylesAt, 'token 必须全部排在 styles.css 之前');
    });
  }
});
