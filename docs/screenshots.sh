#!/bin/sh
# Retakes the README screenshots from the page itself, with made-up accounts
# (docs/demo-data.mjs), in Magpie's light and dark theme, through headless
# Chrome at 2x:
#   sh docs/screenshots.sh            (needs bun and Google Chrome)
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/_magpie"
cp "$root"/page/index.html "$root"/page/app.js "$root"/page/board.js "$root"/page/board.css "$root"/page/style.css "$work/"
cp "$root/docs/screenshot-bridge.js" "$work/_magpie/bridge.js"
${BUN:-bun} "$root/docs/demo-data.mjs" "$work"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
shot() {
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1100,760 \
    --virtual-time-budget=4000 --user-data-dir="$work/profile" --screenshot="$root/docs/images/$1.png" "file://$work/index.html?$2" >/dev/null 2>&1
  echo "docs/images/$1.png"
}
shot list "view=list"
shot rings "view=rings"
shot widgets "view=widgets"
shot alerts "view=list&to=.wb-sched"
shot models-cn "view=models&realm=cn"
shot models-intl "view=models&realm=intl"
shot models-ent "view=models&realm=ent"
shot dark "view=list&dark=1"
