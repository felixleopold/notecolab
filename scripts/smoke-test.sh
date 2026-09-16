#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${PUBLIC_URL:-https://notecolab.com}}"
BASE_URL="${BASE_URL%/}"

if ! command -v curl >/dev/null; then
  echo "Smoke checks require curl." >&2
  exit 1
fi

check_status() {
  local label="$1"
  local expected="$2"
  local url="$3"
  local actual=""
  local attempt=1

  while [ "$attempt" -le 10 ]; do
    if actual=$(curl --silent --show-error --location \
      --connect-timeout 5 --max-time 15 \
      --output /dev/null --write-out '%{http_code}' "$url") \
      && [ "$actual" = "$expected" ]; then
      echo "Smoke check passed: $label returned HTTP $actual."
      return 0
    fi
    [ "$attempt" -lt 10 ] && sleep 2
    attempt=$((attempt + 1))
  done

  echo "Smoke check failed: $label returned HTTP ${actual:-unreachable}; expected $expected ($url)." >&2
  return 1
}

check_status "public homepage" 200 "$BASE_URL/"
check_status "public server info" 200 "$BASE_URL/api/v1/info"
check_status "unauthenticated private API request" 401 "$BASE_URL/api/v1/notes/mine"
