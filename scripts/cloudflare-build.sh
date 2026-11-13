#!/usr/bin/env bash
# Build the static app for Cloudflare Pages.
#
# Cloudflare runs this from the repository root; the project's build command is
#   bash scripts/cloudflare-build.sh
# and its output directory is dist/.
#
# The Pyodide runtime comes from node_modules (npm ci). The sigrok decoder tree
# is not committed; clone a pinned libsigrokdecode revision, stage it through
# the same vendor script the release workflow uses, then build at the domain
# root so the decode worker and PWA resolve absolute URLs correctly.
set -euo pipefail

cd "$(dirname "$0")/.."

# Keep this in sync with .github/workflows/deploy-pages.yml when the decoder set
# is deliberately bumped. Cloudflare can override it with a project variable.
DECODERS_REF="${LIBSIGROKDECODE_REF:-71f451443029322d57376214c330b518efd84f88}"

# Cloudflare may export NODE_ENV=production, which would make npm omit the
# TypeScript/Vite devDependencies this build needs.
npm ci --include=dev

LSRD="${TMPDIR:-/tmp}/libsigrokdecode"
rm -rf "$LSRD"
git clone --quiet https://github.com/sigrokproject/libsigrokdecode.git "$LSRD"
git -C "$LSRD" checkout --quiet "$DECODERS_REF"

# Stages public/pyodide/, public/decoders/decoders.zip and regenerates the
# committed decoder manifest. Needs python3; zip is optional (the vendor script
# falls back to Python's zipfile).
npm run vendor -- "$LSRD/decoders"

# A custom domain is served at the root. The worker's import.meta.env.BASE_URL
# must be absolute; './' resolves against the blob worker and 404s.
npm run build -- --base=/
