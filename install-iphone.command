#!/bin/zsh
# Builds Mula (Release) and installs it on the iPhone plugged into this Mac.
# Uses xcodebuild + devicectl directly, so it doesn't need the iOS simulators (or the T7).
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.homebrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "== Finding your iPhone (keep it plugged in and unlocked) =="
xcrun devicectl list devices --json-output /tmp/mula-devices.json >/dev/null
DEVICE=$(node -e '
  const d = require("/tmp/mula-devices.json").result.devices
    .filter(x => x.hardwareProperties?.platform === "iOS" && x.connectionProperties?.tunnelState !== "unavailable");
  if (d[0]) console.log(d[0].identifier);
')
if [ -z "$DEVICE" ]; then
  echo "No iPhone found. Plug it in, unlock it, tap Trust if asked, then run this again."
  exit 1
fi
echo "iPhone: $DEVICE"

APP=ios/build/device/Build/Products/Release-iphoneos/Mula.app
rm -rf "$APP"
echo "== Building Mula (a few minutes) =="
npm ci --no-audit --no-fund >/dev/null
(cd ios && pod install >/dev/null)
xcodebuild -workspace ios/Mula.xcworkspace -scheme Mula -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath ios/build/device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=JP384292LF build | grep -E "error:|BUILD (SUCCEEDED|FAILED)|Signing" || true

if [ ! -d "$APP" ]; then
  echo "The build failed. Send Claude the output above."
  exit 1
fi

echo "== Installing on your iPhone =="
xcrun devicectl device install app --device "$DEVICE" "$APP"
echo "Done. Open Mula on your iPhone. You can close this window."
