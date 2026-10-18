#!/usr/bin/env bash
# Serve the Control Room publicly for judges: UI + API on one origin, behind an access code,
# exposed with ngrok, laptop kept awake. Ctrl+C stops everything.
#
#   scripts/serve-public.sh                  # generates an access code
#   FACTORY_ACCESS_CODE=my-code scripts/serve-public.sh
#   NGROK_URL=my-name.ngrok-free.app scripts/serve-public.sh   # use your reserved ngrok domain
#
# If the domain is held by an ngrok Cloud Endpoint (what ngrok's onboarding creates), connect the
# agent to the endpoint's internal URL instead and say which public URL to print:
#   NGROK_URL=https://default.internal PUBLIC_URL=https://my-name.ngrok-free.dev scripts/serve-public.sh
#
# Let the factory pick up its own work from GitHub (issues labelled `autofix`):
#   FACTORY_INTAKE_REPO=owner/target-repo scripts/serve-public.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8100}"
export FACTORY_ACCESS_CODE="${FACTORY_ACCESS_CODE:-df-$(python3 -c 'import secrets;print(secrets.token_urlsafe(9))')}"

[ -s .env ] || { echo "missing .env with NEBIUS_API_KEY"; exit 1; }
command -v ngrok >/dev/null || { echo "ngrok not installed"; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use (stop the other factory serve first)"; exit 1
fi

echo "› building UI for same-origin serving"
(cd ui && npm ci --no-audit --no-fund --silent && VITE_API_URL= npm run build --silent >/dev/null)

echo "› starting production"
.venv/bin/factory prod start

LOG_DIR="logs"; mkdir -p "$LOG_DIR"
# lets the GitHub intake (FACTORY_INTAKE_REPO) link to the Control Room in its issue comments
export FACTORY_PUBLIC_URL="${PUBLIC_URL:-${FACTORY_PUBLIC_URL:-}}"
echo "› starting factory serve on :$PORT (laptop kept awake while it runs)"
[ -n "${FACTORY_INTAKE_REPO:-}" ] && echo "› GitHub intake on: issues labelled 'autofix' on $FACTORY_INTAKE_REPO"
caffeinate -dimsu .venv/bin/factory serve --port "$PORT" >"$LOG_DIR/serve.log" 2>&1 &
SERVE_PID=$!

if [ -n "${NGROK_URL:-}" ]; then
  ngrok http "$PORT" --url "$NGROK_URL" --log stdout >"$LOG_DIR/ngrok.log" 2>&1 &
else
  ngrok http "$PORT" --log stdout >"$LOG_DIR/ngrok.log" 2>&1 &
fi
NGROK_PID=$!
trap 'echo; echo "› stopping"; kill $NGROK_PID $SERVE_PID 2>/dev/null; wait 2>/dev/null' EXIT INT TERM

for _ in $(seq 60); do
  PUBLIC=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c \
    'import json,sys;t=[x["public_url"] for x in json.load(sys.stdin).get("tunnels",[]) if x["public_url"].startswith("https")];print(t[0] if t else "")' 2>/dev/null || true)
  if [ -n "$PUBLIC" ] && [ -n "${PUBLIC_URL:-}" ]; then PUBLIC="$PUBLIC_URL"; fi
  [ -n "$PUBLIC" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/api/line?code=$FACTORY_ACCESS_CODE" && break
  sleep 1
done
[ -n "${PUBLIC:-}" ] || { echo "ngrok did not come up; see $LOG_DIR/ngrok.log"; exit 1; }

cat <<MSG

  ┌──────────────────────────────────────────────────────────────────────┐
    Link for judges (valid while this runs):

      $PUBLIC/?code=$FACTORY_ACCESS_CODE

    Without ?code=... the site and API answer 401.
    Logs: $LOG_DIR/serve.log, $LOG_DIR/ngrok.log
    Keep the laptop plugged in, lid open, on stable network. Ctrl+C stops.
  └──────────────────────────────────────────────────────────────────────┘

MSG
wait $SERVE_PID
