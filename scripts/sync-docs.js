#!/usr/bin/env node

/**
 * 同步 Markdown 文件到 public 目录
 * 用于不支持软链接的环境（如 Windows）
 */

const fs = require('fs');
const path = require('path');

const FILES = [
  'README.md',
  'PRIVACY_POLICY.md',
  'TERMS_OF_SERVICE.md'
];

console.log('同步 Markdown 文件到 public/ 目录...\n');

let successCount = 0;
let errorCount = 0;

FILES.forEach(file => {
  const srcPath = path.join(__dirname, '..', file);
  const destPath = path.join(__dirname, '..', 'public', file);

  try {
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`✓ 已复制: ${file}`);
      successCount++;
    } else {
      console.log(`✗ 文件不存在: ${file}`);
      errorCount++;
    }
  } catch (error) {
    console.error(`✗ 复制失败: ${file} - ${error.message}`);
    errorCount++;
  }
});

console.log(`\n同步完成！成功: ${successCount}, 失败: ${errorCount}`);

if (errorCount > 0) {
  process.exit(1);
}
