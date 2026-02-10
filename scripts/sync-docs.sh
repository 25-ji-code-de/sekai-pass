#!/bin/bash

# 同步 Markdown 文件到 public 目录
# 用于不支持软链接的环境（如 Windows）

echo "同步 Markdown 文件到 public/ 目录..."

# 要同步的文件列表
FILES=(
  "README.md"
  "PRIVACY_POLICY.md"
  "TERMS_OF_SERVICE.md"
)

# 复制文件
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    cp "$file" "public/$file"
    echo "✓ 已复制: $file"
  else
    echo "✗ 文件不存在: $file"
  fi
done

echo "同步完成！"
