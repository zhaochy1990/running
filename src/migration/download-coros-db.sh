#!/bin/bash
# Download coros.db (+ wal/shm) for all real users from Azure Files stride-data
# share into ./data-snapshot/<uuid>/.
#
# Why this exists: `az storage file download` stalls / hangs on the large
# (400-800MB) coros.db files, and `az storage file exists` returns lowercase
# `true` (not `True`), so a naive case-sensitive comparison skips every file.
# This script uses `az storage file exists` re-cased, then downloads each file
# as parallel HTTP Range requests (curl + SAS) so big files transfer reliably,
# and grabs coros.db-wal together with the main db (SQLite WAL mode: recent
# writes — incl. body_composition_scan — may live only in the WAL).
#
# Usage: bash download-coros-db.sh [--all]
#   --all   download all UUID dirs in the share, not just real-user allowlist

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data-snapshot"
mkdir -p "$DATA_DIR"

KEY=$(az storage account keys list --account-name authstorage2026 --resource-group rg-common-prod --query "[0].value" -o tsv)
if [ -z "$KEY" ]; then
  echo "ERROR: failed to get storage account key" >&2
  exit 1
fi

# Real user allowlist (from src/users.js)
REAL_USERS=(
  "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9"
  "5ee229a6-cdc1-4260-84d3-71ec622126c2"
  "7bd56762-3b04-42a6-9d8b-98f595628430"
  "0a74ac88-629e-4b8e-97c8-d49ccf5a986b"
  "bffa65bc-4501-41e7-a68c-96da76d5b7bc"
  "d3438b21-0d9b-4432-96c6-bb5564b74141"
  "db2470c4-885b-496f-896a-764c0dedbaea"
  "ba103cff-ad2c-4f9e-9920-983337544a2c"
  "f10bc353-01ab-4db1-af9f-d9305ea9a532"
)

# Download one file via parallel HTTP Range requests. Reassembles from parts,
# verifies total size, and retries each part. Exits non-zero on any failure.
# Uses a fresh SAS per file so the key stays out of the URL for long.
download_file() {
  local path="$1" dest="$2" conns="${3:-48}" retries="${4:-8}"
  local sas url size
  sas=$(az storage file generate-sas \
    --account-name authstorage2026 --account-key "$KEY" \
    --share-name stride-data --path "$path" \
    --permissions r --expiry 2026-09-05T00:00:00Z -o tsv)
  url="https://authstorage2026.file.core.windows.net/stride-data/$path?$sas"
  size=$(az storage file show --account-name authstorage2026 --account-key "$KEY" \
    --share-name stride-data --path "$path" --query "properties.contentLength" -o tsv)
  if [ -z "$size" ]; then echo "  no size for $path" >&2; return 1; fi

  local part i s e exp sz attempt
  for i in $(seq 0 $((conns-1))); do
    s=$(( i * size / conns ))
    e=$(( (i+1) * size / conns - 1 ))
    exp=$(( (i+1) * size / conns - i * size / conns ))
    (
      for attempt in $(seq 1 "$retries"); do
        curl -sS -o "$dest.part.$i.tmp" --max-time 600 -r "$s-$e" "$url" 2>/dev/null
        if [ -f "$dest.part.$i.tmp" ]; then
          sz=$(stat -f%z "$dest.part.$i.tmp" 2>/dev/null || echo 0)
          if [ "$sz" -eq "$exp" ]; then mv "$dest.part.$i.tmp" "$dest.part.$i"; exit 0; fi
        fi
        rm -f "$dest.part.$i.tmp"
        sleep "$attempt"
      done
      echo "  [FAIL] part $i of $path" >&2
      exit 1
    ) &
  done

  local ok=1 p
  for p in $(jobs -p); do wait "$p" || ok=0; done
  if [ "$ok" != 1 ]; then rm -f "$dest.part."*; echo "  [FAIL] $path" >&2; return 1; fi

  : > "$dest.assembled"
  for i in $(seq 0 $((conns-1))); do cat "$dest.part.$i" >> "$dest.assembled"; rm -f "$dest.part.$i"; done
  if [ "$(stat -f%z "$dest.assembled")" != "$size" ]; then rm -f "$dest.assembled"; echo "  [FAIL] $path size mismatch" >&2; return 1; fi
  mv "$dest.assembled" "$dest"
  echo "  done $(stat -f%z "$dest") bytes"
}

download_user() {
  local uuid="$1"
  local user_dir="$DATA_DIR/$uuid"
  rm -rf "$user_dir"
  mkdir -p "$user_dir"

  local exists
  exists=$(az storage file exists \
    --account-name authstorage2026 \
    --account-key "$KEY" \
    --share-name stride-data \
    --path "$uuid/coros.db" \
    --query "exists" -o tsv 2>/dev/null || echo false)
  # az returns lowercase boolean; compare case-insensitively.
  if [ "$(printf '%s' "$exists" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
    echo "  [skip] $uuid — no coros.db"
    return 0
  fi

  echo "  [dl]   $uuid"
  local ok=1
  for f in coros.db coros.db-wal coros.db-shm; do
    local fexists
    fexists=$(az storage file exists \
      --account-name authstorage2026 \
      --account-key "$KEY" \
      --share-name stride-data \
      --path "$uuid/$f" \
      --query "exists" -o tsv 2>/dev/null || echo false)
    if [ "$(printf '%s' "$fexists" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
      download_file "$uuid/$f" "$user_dir/$f" 48 8 || ok=0
    fi
  done
  if [ "$ok" -ne 1 ]; then
    echo "    dl failed"
    rm -rf "$user_dir"
    return 0
  fi
  echo "    db=$(stat -f%z "$user_dir/coros.db" 2>/dev/null || echo 0) wal=$(stat -f%z "$user_dir/coros.db-wal" 2>/dev/null || echo 0) bytes"
}

echo "Downloading coros.db files to $DATA_DIR"
echo "Users: ${#REAL_USERS[@]}"
echo

for uuid in "${REAL_USERS[@]}"; do
  download_user "$uuid"
done

echo
echo "=== Body composition scan counts ==="
for uuid in "${REAL_USERS[@]}"; do
  db="$DATA_DIR/$uuid/coros.db"
  if [ -s "$db" ]; then
    count=$(sqlite3 "$db" "SELECT COUNT(*) FROM body_composition_scan;" 2>/dev/null || echo "no_table")
    printf "  %s  %s\n" "$uuid" "$count"
  else
    printf "  %s  no file\n" "$uuid"
  fi
done
