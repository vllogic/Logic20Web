#!/usr/bin/env bash
# Alternative build entry for Cloudflare Pages Git integration.
#
# Workers Builds (the default `npm run build` + `npx wrangler deploy` setup) does
# not use this script. Pages users can set the build command to:
#   bash scripts/cloudflare-build.sh
# and the output directory to dist/.
#
# `npm run build` runs the prebuild hook, which installs dependencies when
# missing, clones the pinned libsigrokdecode revision, stages Pyodide and the
# decoder tree, then builds at the domain root.
set -euo pipefail

cd "$(dirname "$0")/.."
npm ci --include=dev
npm run build
