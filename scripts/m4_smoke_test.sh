#!/bin/bash
# M4 Smoke Test — run after prod deploy completes.
# Uses .credentials.local for auth.
set -e

PROD_URL="${STRIDE_PROD_URL:-https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io}"
AUTH_URL="${STRIDE_AUTH_URL:-https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io}"
CLIENT_ID="${STRIDE_CLIENT_ID:-app_62978bf2803346878a2e4805}"

EMAIL=$(awk -F'= ' '/^email/{print $2}' .credentials.local | tr -d ' ')
PASSWORD=$(awk -F'= ' '/^password/{print $2}' .credentials.local | tr -d ' ')

echo "=== 1. /api/health (no auth) ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROD_URL/api/health"

echo "=== 2. Login ==="
LOGIN_RESPONSE=$(curl -s -X POST "$AUTH_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-Client-Id: $CLIENT_ID" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | python -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
if [ -z "$ACCESS_TOKEN" ]; then
  echo "Login failed: $LOGIN_RESPONSE"
  exit 1
fi
echo "Login OK, token len: ${#ACCESS_TOKEN}"

echo "=== 3. /api/users/me/profile ==="
PROFILE=$(curl -s "$PROD_URL/api/users/me/profile" -H "Authorization: Bearer $ACCESS_TOKEN")
USER_ID=$(echo "$PROFILE" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or d.get('user_id') or d.get('sub',''))")
echo "User id: $USER_ID"
[ -z "$USER_ID" ] && echo "Profile: $PROFILE" && exit 1

echo "=== 4. /api/$USER_ID/home ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROD_URL/api/$USER_ID/home" -H "Authorization: Bearer $ACCESS_TOKEN"

echo "=== 5. /api/users/me/master-plan/current ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROD_URL/api/users/me/master-plan/current" -H "Authorization: Bearer $ACCESS_TOKEN"

echo "=== 6. /api/$USER_ID/race-predictions (M4 new) ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROD_URL/api/$USER_ID/race-predictions" -H "Authorization: Bearer $ACCESS_TOKEN"

echo "=== 7. /api/$USER_ID/pbs (M4 new) ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROD_URL/api/$USER_ID/pbs" -H "Authorization: Bearer $ACCESS_TOKEN"

echo "=== All endpoints exercised ==="
