#!/bin/zsh
# Updates Mula after code changes: deploys the Claude connector (relay) to Cloudflare,
# then rebuilds and installs the app on the iPhone plugged into this Mac.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.homebrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "== 1/2 Deploying the Claude connector =="
cd relay
npm ci --no-audit --no-fund
npx wrangler deploy   # first time on this Mac it opens a Cloudflare sign-in page
cd ..

echo "== 2/2 Installing the app on your iPhone (keep it plugged in and unlocked) =="
./install-iphone.command

echo "Done. You can close this window."
