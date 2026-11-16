#!/usr/bin/env bash
# Builds the pi-dev Gondolin guest image used by this extension.
#   ./build-image.sh            -> builds and tags pi-dev:latest
# Requires: brew install e2fsprogs qemu
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$(brew --prefix e2fsprogs)/sbin:$PATH"

TAG="${1:-pi-dev:latest}"
OVERLAY="$PWD/image-overlay"

# Playwright is pure JS: stage it on the host and copy it into the rootfs
# (postBuild.commands would need Docker). It drives the Alpine chromium package.
rm -rf "$OVERLAY"
mkdir -p "$OVERLAY/usr/local/lib" "$OVERLAY/usr/local/bin"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$OVERLAY/usr/local/lib" \
	--no-save --no-package-lock --ignore-scripts --omit=dev playwright >/dev/null
rm -f "$OVERLAY/usr/local/lib/package.json"
ln -s ../lib/node_modules/playwright/cli.js "$OVERLAY/usr/local/bin/playwright"

npx gondolin build --config image-config.json --tag "$TAG"
npx gondolin image ls
