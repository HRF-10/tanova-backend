#!/usr/bin/env bash
set -u
BASE="${1:?BASE}"; KEY="${2:?KEY}"; DEV="${3:?DEVICE_ID}"; OK="${4:?daun.jpg}"; NO="${5:?bukan-tanaman.jpg}"
pass=0; fail=0
check() { # nama, status_diharapkan, status_asli
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; pass=$((pass+1)); else echo "FAIL $1 (harap $2, dapat $3)"; fail=$((fail+1)); fi
}
call() { curl -s -o /tmp/resp.json -w "%{http_code}" -X POST "$BASE/api/v1/ai/analyze?device_id=$1" \
  -H "x-api-key: $2" -H "Content-Type: image/jpeg" --data-binary "@$3"; }

s=$(call "$DEV" "$KEY" "$OK");  check "foto daun -> tersimpan" 201 "$s"
# field yang dibaca firmware harus ada, confidence harus angka 0..1
jq -e '.saved==true and (.label|type=="string") and (.category|type=="string") and (.confidence|type=="number" and .>=0 and .<=1)' /tmp/resp.json >/dev/null \
  && echo "PASS bentuk JSON 201" || { echo "FAIL bentuk JSON 201:"; cat /tmp/resp.json; fail=$((fail+1)); }
s=$(call "$DEV" "$KEY" "$NO");  check "bukan tanaman" 200 "$s"
jq -e '.is_plant==false' /tmp/resp.json >/dev/null && echo "PASS is_plant:false" || { echo "FAIL is_plant"; fail=$((fail+1)); }
s=$(call "$DEV" "kunci-salah" "$OK"); check "kunci salah" 401 "$s"
s=$(call "id-tidak-ada" "$KEY" "$OK"); check "device salah" 404 "$s"
jq -e '.message|type=="string"' /tmp/resp.json >/dev/null && echo "PASS error punya field message" || { echo "FAIL field message"; fail=$((fail+1)); }
echo "Hasil: $pass lulus, $fail gagal"; [ "$fail" -eq 0 ]
