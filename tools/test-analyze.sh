#!/usr/bin/env bash
# Uji endpoint kamera backend tanpa ESP32.
# Pakai: ./test-analyze.sh http://192.168.1.10:3000 <CAMERA_API_KEY> <DEVICE_ID> foto-daun.jpg
set -euo pipefail
BASE="${1:?base url, contoh http://192.168.1.10:3000}"
KEY="${2:?CAMERA_API_KEY}"
DEV="${3:?device id dari GET /api/v1/devices}"
IMG="${4:?file jpg}"

echo "== health"; curl -fsS "$BASE/api/v1/health" 2>/dev/null || curl -fsS -o /dev/null -w "docs HTTP %{http_code}\n" "$BASE/docs"
echo "== analyze"
curl -sS -i -X POST "$BASE/api/v1/ai/analyze?device_id=$DEV" \
  -H "x-api-key: $KEY" -H "Content-Type: image/jpeg" --data-binary "@$IMG"
echo
echo "Harapan: 201 {saved:true,...} atau 200 {saved:false,is_plant:false}"
