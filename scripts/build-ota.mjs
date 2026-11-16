#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Build the standalone /ota/ page into dist/ota/.
 *
 * This is a separate Vite config on purpose: the analyzer's build inlines its
 * entry into dist/index.html, emits a service worker and has a portable
 * single-file mode that forbids sibling files. None of that applies to /ota/,
 * which is a plain static page over the protocol modules in src/device/iap.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

if (process.env.SLOGICWEB_PORTABLE === '1') {
  console.log('[ota] skipped: the portable single-file build keeps nothing beside index.html');
  process.exit(0);
}

const gen = spawnSync(process.execPath, [join(ROOT, 'scripts/gen-ota-manifest.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (gen.status !== 0) process.exit(gen.status ?? 1);

const vite = join(ROOT, 'node_modules/.bin/vite');
if (!existsSync(vite)) {
  console.error('[ota] vite is missing; run npm install');
  process.exit(1);
}
const build = spawnSync(vite, ['build', '--config', 'ota/vite.config.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (build.error) {
  console.error(`[ota] ${build.error.message}`);
  process.exit(1);
}
process.exit(build.status ?? 1);
