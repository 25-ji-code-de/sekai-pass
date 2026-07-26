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
const tokens = readFileSync(join(root, 'public/css/sekai-tokens.css'), 'utf8');
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

/**
 * 取某个选择器块里定义的全部 `--name: value`。
 *
 * `from` 是起始偏移量，必须给对：文件里有**四个** `:root {`
 * （primitives 一个、contract 一个、两个 world 各一个）。第一版没带偏移，
 * 结果 `:root` 永远匹配到 primitives 那块 —— 里面一个颜色 token 都没有，
 * 于是下面那条"兜底与 world-system 一致"的比对全程空转。
 * 反向验证时改坏 world-system 的取值，测试照样全绿，才发现。
 */
function blockTokens(css: string, selector: string, from = 0): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)[^\\n{}]*${escaped}[^\\n{}]*\\{([\\s\\S]*?)\\n\\}`).exec(
    css.slice(from),
  );
  const out = new Map<string, string>();
  if (!m) return out;
  for (const d of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(d[1], d[2].trim().replace(/\s*\/\*[\s\S]*$/, '').trim());
  }
  return out;
}

/** 某一层的起始偏移。 */
function layerAt(marker: string): number {
  const at = tokens.indexOf(marker);
  assert.ok(at > 0, `token 文件里找不到 ${marker}`);
  return at;
}

describe('vendored 的 token 文件', () => {
  test('四层都在：primitives / contract / 两个 world', () => {
    assert.match(tokens, /Layer 0: Primitives/);
    assert.match(tokens, /Layer 1: The semantic contract/);
    assert.match(tokens, /World: SYSTEM/i);
    assert.match(tokens, /World: NIGHT/i);
  });

  test('记了上游的 commit —— 不然没法判断同步到了哪一版', () => {
    // 只断言"记了"，不比对整份文件 —— 失败时把 16KB CSS 打进日志毫无帮助
    const header = tokens.slice(0, tokens.indexOf('Layer 0: Primitives'));
    assert.ok(
      /sekai-design[^\n]*@\s*[0-9a-f]{7,}/.test(header),
      '文件头没有记录上游 commit',
    );
  });

  test('说明了内容取自提交树而不是工作区', () => {
    // 上游正在开发，工作区随时和任何一个 commit 都对不上；
    // 标了 commit 却抄工作区，这行出处比没有还坏
    assert.match(tokens, /提交树/);
  });

  test('两个 world 都是类作用域', () => {
    /*
     * world-night 排在 world-system 之后加载。它要是写成裸 :root，
     * 本仓（world-system）就会被整个盖掉 —— 而且不会有任何报错，
     * 只是颜色全变了。
     *
     * 判据：从每个 world 的标题注释往下，遇到的第一个选择器必须带 class。
     */
    for (const world of ['SYSTEM', 'NIGHT']) {
      const at = tokens.indexOf(`World: ${world}`);
      assert.ok(at > 0, `找不到 World: ${world}`);
      const selector = /\n([^\n{}]+)\{/.exec(tokens.slice(at))?.[1] ?? '';
      assert.match(
        selector,
        /\.world-(system|night)/,
        `World: ${world} 的第一个选择器不是类作用域：${selector.trim()}`,
      );
    }
  });

  test('contract 的 :root 兜底与 world-system 逐项一致', () => {
    /*
     * contract 的 :root 是"没挂任何 world class 时"的取值，注释里写明
     * 它就是 world-system。两者一旦分叉，同一个页面加不加
     * class="world-system" 会渲染成两个样子，而且不会有任何报错。
     */
    const fallback = blockTokens(tokens, ':root', layerAt('Layer 1: The semantic contract'));
    const system = blockTokens(tokens, ':root.world-system', layerAt('World: SYSTEM'));

    // 先确认两边都真的解析出东西了 —— 解析空了的话下面的比对就是空转
    assert.ok(fallback.has('sekai-accent'), 'contract 的 :root 没解析出调色板');
    assert.ok(system.size > 10, `world-system 块只解析出 ${system.size} 个 token`);
    assert.ok(system.has('sekai-accent'), 'world-system 块没解析出 --sekai-accent');

    const shared = [...system.keys()].filter((k) => fallback.has(k));
    assert.ok(shared.length > 10, `两边只有 ${shared.length} 个同名 token，比对不成立`);

    const mismatched = shared
      .filter((k) => fallback.get(k) !== system.get(k))
      .map((k) => `--${k}: 兜底 ${fallback.get(k)} ≠ world-system ${system.get(k)}`);
    assert.deepEqual(mismatched, []);
  });

  test('注明了出处，并说明不要就地改值', () => {
    assert.match(tokens, /sekai-design/);
    assert.match(tokens, /不要在这里改任何值/);
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

describe('token 表在 styles.css 之前加载', () => {
  // 顺序反了的话，别名读到的是空值，整页会退化成浏览器默认色
  for (const file of ['public/index.html', 'src/lib/html.ts']) {
    test(file, () => {
      const html = readFileSync(join(root, file), 'utf8');
      const tokensAt = html.indexOf('/css/sekai-tokens.css');
      const stylesAt = html.indexOf('/css/styles.css');
      assert.ok(tokensAt >= 0, '没有引入 sekai-tokens.css');
      assert.ok(stylesAt >= 0, '没有引入 styles.css');
      assert.ok(tokensAt < stylesAt, 'sekai-tokens.css 必须在 styles.css 之前');
    });
  }
});
