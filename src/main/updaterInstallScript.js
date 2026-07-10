/**
 * Manual macOS update install script (unsigned/ad-hoc builds only).
 * Squirrel.Mac refuses unsigned apps, so autoUpdater falls back to replacing
 * the bundle itself: wait for the app to exit, extract the downloaded zip,
 * swap the bundle with rollback (the old app is only deleted after the new
 * one is in place), then relaunch.
 *
 * Kept free of electron imports so it can be exercised by unit tests.
 */

const MANUAL_INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; ZIP="$2"; APP="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
EXTRACT=$(mktemp -d) || exit 1
ditto -xk "$ZIP" "$EXTRACT" || { rm -rf "$EXTRACT"; exit 1; }
NEW_APP=$(find "$EXTRACT" -maxdepth 1 -name '*.app' -print | head -n 1)
[ -n "$NEW_APP" ] || { rm -rf "$EXTRACT"; exit 1; }
OLD_APP="$APP.old.$$"
mv "$APP" "$OLD_APP" || { rm -rf "$EXTRACT"; exit 1; }
if mv "$NEW_APP" "$APP"; then
  rm -rf "$OLD_APP"
else
  mv "$OLD_APP" "$APP"
  rm -rf "$EXTRACT"
  exit 1
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
rm -rf "$EXTRACT"
rm -f "$0"
open "$APP"
`;

module.exports = { MANUAL_INSTALL_SCRIPT };
