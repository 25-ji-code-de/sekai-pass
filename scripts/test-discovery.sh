#!/bin/bash

# OAuth Discovery Endpoint 测试脚本

BASE_URL="https://id.nightcord.de5.net"

echo "======================================"
echo "测试 OAuth Discovery Endpoint"
echo "======================================"
echo ""

echo "1. 测试标准 Discovery Endpoint"
echo "GET ${BASE_URL}/.well-known/oauth-authorization-server"
echo ""
curl -s "${BASE_URL}/.well-known/oauth-authorization-server" | jq '.'
echo ""
echo ""

echo "2. 测试简化版 API Endpoint"
echo "GET ${BASE_URL}/api/oauth/config"
echo ""
curl -s "${BASE_URL}/api/oauth/config" | jq '.'
echo ""
echo ""

echo "======================================"
echo "验证必需字段"
echo "======================================"
echo ""

# 验证标准端点
DISCOVERY=$(curl -s "${BASE_URL}/.well-known/oauth-authorization-server")

echo "检查 authorization_endpoint..."
echo "$DISCOVERY" | jq -e '.authorization_endpoint' > /dev/null && echo "✅ 存在" || echo "❌ 缺失"

echo "检查 token_endpoint..."
echo "$DISCOVERY" | jq -e '.token_endpoint' > /dev/null && echo "✅ 存在" || echo "❌ 缺失"

echo "检查 userinfo_endpoint..."
echo "$DISCOVERY" | jq -e '.userinfo_endpoint' > /dev/null && echo "✅ 存在" || echo "❌ 缺失"

echo "检查 code_challenge_methods_supported..."
echo "$DISCOVERY" | jq -e '.code_challenge_methods_supported | contains(["S256"])' > /dev/null && echo "✅ 支持 S256" || echo "❌ 不支持 S256"

echo ""
echo "======================================"
echo "测试完成"
echo "======================================"
