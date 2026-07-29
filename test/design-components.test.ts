import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('SEKAI Design auth layout', () => {
  for (const [file, source] of [
    ['signatures.css', 'css/signatures.css'],
    ['auth.css', 'css/layout/auth.css'],
  ]) {
    test(`${file} is pinned to the tagged source`, () => {
      assert.match(
        read(`public/css/sekai/${file}`),
        new RegExp(`^/\\* @sekai-vendor @sekai/design@v0\\.1\\.0 ${source.replaceAll('/', '\\/')} \\*/`),
      );
    });
  }

  test('both authorize renderers consume upstream component classes', () => {
    for (const file of ['public/js/pages/authorize.js', 'src/lib/html.ts']) {
      const source = read(file);
      for (const className of ['sekai-connection', 'sekai-entity', 'sekai-flow', 'sekai-connection__badge']) {
        assert.match(source, new RegExp(`\\b${className}\\b`), `${file} does not use ${className}`);
      }
    }
  });

  test('local CSS no longer redefines the shared structure', () => {
    const css = read('public/css/styles.css');
    for (const selector of ['connection-visual', 'entity', 'connection-line', 'connection-icon']) {
      assert.doesNotMatch(css, new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{`));
    }
  });
});
