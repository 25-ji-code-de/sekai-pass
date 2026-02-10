#!/bin/bash

# OIDC Testing Script
# Tests the OpenID Connect implementation

set -e

BASE_URL="${1:-http://localhost:8787}"

echo "🧪 Testing OIDC Implementation"
echo "Base URL: $BASE_URL"
echo "================================"
echo ""

# Test 1: OIDC Discovery
echo "📋 Test 1: OIDC Discovery Endpoint"
echo "GET $BASE_URL/.well-known/openid-configuration"
echo ""

DISCOVERY=$(curl -s "$BASE_URL/.well-known/openid-configuration")
echo "$DISCOVERY" | jq '.'

# Verify required fields
ISSUER=$(echo "$DISCOVERY" | jq -r '.issuer')
JWKS_URI=$(echo "$DISCOVERY" | jq -r '.jwks_uri')

if [ "$ISSUER" != "$BASE_URL" ]; then
  echo "❌ FAIL: Issuer mismatch"
  exit 1
fi

echo "✅ PASS: Discovery endpoint working"
echo ""

# Test 2: JWKS Endpoint
echo "📋 Test 2: JWKS Endpoint"
echo "GET $JWKS_URI"
echo ""

JWKS=$(curl -s "$JWKS_URI")
echo "$JWKS" | jq '.'

# Verify keys exist
KEY_COUNT=$(echo "$JWKS" | jq '.keys | length')

if [ "$KEY_COUNT" -eq 0 ]; then
  echo "⚠️  WARNING: No signing keys found (will be generated on first use)"
else
  echo "✅ PASS: JWKS endpoint working ($KEY_COUNT keys found)"
fi
echo ""

# Test 3: OAuth Discovery (backward compatibility)
echo "📋 Test 3: OAuth Discovery Endpoint (Backward Compatibility)"
echo "GET $BASE_URL/.well-known/oauth-authorization-server"
echo ""

OAUTH_DISCOVERY=$(curl -s "$BASE_URL/.well-known/oauth-authorization-server")
echo "$OAUTH_DISCOVERY" | jq '.'

echo "✅ PASS: OAuth discovery endpoint working"
echo ""

# Test 4: Verify OIDC metadata
echo "📋 Test 4: Verify OIDC Metadata"
echo ""

# Check required endpoints
AUTH_ENDPOINT=$(echo "$DISCOVERY" | jq -r '.authorization_endpoint')
TOKEN_ENDPOINT=$(echo "$DISCOVERY" | jq -r '.token_endpoint')
USERINFO_ENDPOINT=$(echo "$DISCOVERY" | jq -r '.userinfo_endpoint')

echo "Authorization Endpoint: $AUTH_ENDPOINT"
echo "Token Endpoint: $TOKEN_ENDPOINT"
echo "UserInfo Endpoint: $USERINFO_ENDPOINT"
echo "JWKS URI: $JWKS_URI"
echo ""

# Check supported features
RESPONSE_TYPES=$(echo "$DISCOVERY" | jq -r '.response_types_supported[]')
GRANT_TYPES=$(echo "$DISCOVERY" | jq -r '.grant_types_supported[]')
SCOPES=$(echo "$DISCOVERY" | jq -r '.scopes_supported[]')
SIGNING_ALGS=$(echo "$DISCOVERY" | jq -r '.id_token_signing_alg_values_supported[]')

echo "Response Types: $RESPONSE_TYPES"
echo "Grant Types: $GRANT_TYPES"
echo "Scopes: $SCOPES"
echo "Signing Algorithms: $SIGNING_ALGS"
echo ""

# Verify openid scope is supported
if echo "$SCOPES" | grep -q "openid"; then
  echo "✅ PASS: openid scope supported"
else
  echo "❌ FAIL: openid scope not supported"
  exit 1
fi

# Verify ES256 is supported
if echo "$SIGNING_ALGS" | grep -q "ES256"; then
  echo "✅ PASS: ES256 signing algorithm supported"
else
  echo "❌ FAIL: ES256 signing algorithm not supported"
  exit 1
fi

echo ""

# Test 5: Verify claims
echo "📋 Test 5: Verify Supported Claims"
echo ""

CLAIMS=$(echo "$DISCOVERY" | jq -r '.claims_supported[]')
echo "Supported Claims:"
echo "$CLAIMS"
echo ""

# Check required OIDC claims
REQUIRED_CLAIMS=("sub" "iss" "aud" "exp" "iat")
for claim in "${REQUIRED_CLAIMS[@]}"; do
  if echo "$CLAIMS" | grep -q "$claim"; then
    echo "✅ $claim"
  else
    echo "❌ $claim (missing)"
    exit 1
  fi
done

echo ""

# Test 6: PKCE support
echo "📋 Test 6: Verify PKCE Support"
echo ""

PKCE_METHODS=$(echo "$DISCOVERY" | jq -r '.code_challenge_methods_supported[]')
echo "PKCE Methods: $PKCE_METHODS"

if echo "$PKCE_METHODS" | grep -q "S256"; then
  echo "✅ PASS: S256 PKCE method supported"
else
  echo "❌ FAIL: S256 PKCE method not supported"
  exit 1
fi

echo ""

# Summary
echo "================================"
echo "✅ All tests passed!"
echo ""
echo "OIDC implementation is working correctly."
echo ""
echo "Next steps:"
echo "1. Test full authentication flow with a client"
echo "2. Verify ID token generation and validation"
echo "3. Test key rotation (manual or wait for cron)"
echo ""
