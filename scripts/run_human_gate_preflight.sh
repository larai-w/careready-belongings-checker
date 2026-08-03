#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

run_with_timeout() {
  local max_seconds="$1"
  shift

  "$@" &
  local command_pid=$!
  local checks=$((max_seconds * 4))
  for _ in $(seq 1 "$checks"); do
    if ! kill -0 "$command_pid" 2>/dev/null; then
      wait "$command_pid"
      return $?
    fi
    sleep 0.25
  done

  kill "$command_pid" 2>/dev/null || true
  sleep 1
  kill -9 "$command_pid" 2>/dev/null || true
  wait "$command_pid" 2>/dev/null || true
  return 124
}

if [ -n "${CHROME_BIN:-}" ]; then
  CHROME="$CHROME_BIN"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME="$(command -v google-chrome)"
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  echo "Google Chrome was not found. Set CHROME_BIN to its executable path." >&2
  exit 1
fi

if [ -x "backend/.venv/bin/python" ]; then
  BACKEND_PYTHON="backend/.venv/bin/python"
else
  BACKEND_PYTHON="python3"
fi

echo "[1/5] Static and public-boundary checks"
python3 scripts/check_public_repo.py --tracked
node --check app.js
node --check storage.js
node --check sw.js
node --check admin/admin.js
python3 -c "import json; json.load(open('data.json')); json.load(open('manifest.webmanifest'))"
python3 scripts/validate_data_contract.py
python3 scripts/check_local_links.py
python3 scripts/validate_content.py
python3 scripts/validate_product_contracts.py
python3 scripts/validate_workflow_security.py
python3 scripts/audit_action_refs.py
python3 scripts/validate_accessibility_contracts.py
python3 scripts/validate_source_policy.py

echo "[2/5] Backend tests"
"$BACKEND_PYTHON" -m pytest backend/tests/ -q

echo "[3/5] Full-history secret scan"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks was not found. Install it before running the release preflight." >&2
  exit 1
fi
gitleaks git . --no-banner --redact

PORT="${CAREREADY_PREFLIGHT_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
BASE_URL="http://127.0.0.1:${PORT}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

SERVER_READY=0
for _ in $(seq 1 40); do
  if python3 -c "import urllib.request; urllib.request.urlopen('${BASE_URL}/', timeout=1).read(1)" >/dev/null 2>&1; then
    SERVER_READY=1
    break
  fi
  sleep 0.25
done
if [ "$SERVER_READY" -ne 1 ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Local server failed to start:" >&2
  sed -n '1,80p' "$TMP_DIR/server.log" >&2
  exit 1
fi

echo "[4/5] Headless smoke"
SMOKE_DOM="$TMP_DIR/smoke-dom.html"
if ! run_with_timeout 120 "$CHROME" --headless=new --disable-gpu --no-sandbox \
  --disable-background-networking --disable-default-apps --no-first-run \
  --user-data-dir="$TMP_DIR/chrome-smoke" \
  --virtual-time-budget=25000 --dump-dom "${BASE_URL}/" \
  >"$SMOKE_DOM" 2>/dev/null; then
  echo "Headless smoke did not finish within 120 seconds." >&2
  exit 1
fi

CHECKBOXES="$({ grep -o 'type="checkbox"' "$SMOKE_DOM" || true; } | wc -l | tr -d ' ')"
if [ "$CHECKBOXES" -lt 20 ]; then
  echo "Expected at least 20 checkboxes; rendered $CHECKBOXES." >&2
  exit 1
fi
for label in "おかえり" "どこへ" "箱に詰める" "の準備"; do
  if ! grep -q "$label" "$SMOKE_DOM"; then
    echo "Required UI label was not rendered: $label" >&2
    exit 1
  fi
done

echo "[5/5] Headless family-flow E2E"
E2E_DOM="$TMP_DIR/e2e-dom.html"
E2E_ATTEMPTS="${E2E_ATTEMPTS:-4}"
E2E_OK=0
for attempt in $(seq 1 "$E2E_ATTEMPTS"); do
  if ! run_with_timeout 180 "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --disable-background-networking --disable-default-apps --no-first-run \
    --user-data-dir="$TMP_DIR/chrome-e2e-${attempt}" \
    --virtual-time-budget=600000 --dump-dom "${BASE_URL}/test-e2e.html" \
    >"$E2E_DOM" 2>/dev/null; then
    echo "E2E attempt $attempt timed out after 180 seconds."
    continue
  fi
  if grep -qF "E2E_RESULT: ALL_PASS" "$E2E_DOM"; then
    echo "E2E PASS on attempt $attempt"
    E2E_OK=1
    break
  fi
  echo "E2E attempt $attempt did not reach ALL_PASS."
done
if [ "$E2E_OK" -ne 1 ]; then
  grep -oE '(PASS|FAIL|WINDOW_ERR|ERR): [^<]*' "$E2E_DOM" | head -40 >&2 || true
  exit 1
fi

cat <<'EOF'

AUTOMATED PREFLIGHT: PASS

Human gate remains OPEN. This command does not verify physical-device rendering,
print output, offline recovery on a real phone, facility sign-in, or operational
handover of a facility code. Complete docs/15_実機E2Eウォークスルー.md before
closing Issue #6.
EOF
