#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * npm's `prebuild` hook: make `npm run build` work on a fresh checkout.
 *
 * Pyodide and the sigrok decoder tree are generated, not committed. A release
 * build vendors them first. Cloudflare Workers Builds runs exactly `npm run
 * build`, so this hook clones the pinned libsigrokdecode revision and stages the
 * two assets only when they are absent; a local tree that already has them pays
 * nothing.
 *
 * The clone lives under tmp/ (gitignored), so it is not part of the artifact.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Workers Builds runs `npm run build`; depending on the project settings it may
// not have installed dependencies first. Make the build self-contained without
// reinstalling on every local build.
if (!existsSync(resolve(root, 'node_modules/.bin/tsc'))) {
  console.log('node_modules is missing; running npm ci --include=dev');
  execFileSync('npm', ['ci', '--include=dev'], { cwd: root, stdio: 'inherit' });
}

const required = [
  'public/pyodide/pyodide.asm.wasm',
  'public/pyodide/python_stdlib.zip',
  'public/pyodide/pyodide-lock.json',
  'public/pyodide/LICENSE-pyodide-MPL-2.0.txt',
  'public/pyodide/LICENSE-cpython-PSF.txt',
  'public/decoders/decoders.zip',
];

const missing = required.filter((rel) => !existsSync(resolve(root, rel)));
if (missing.length === 0) {
  console.log('runtime assets already staged; skipping libsigrokdecode clone');
  process.exit(0);
}

const ref = process.env.LIBSIGROKDECODE_REF || '71f451443029322d57376214c330b518efd84f88';
const checkout = resolve(root, 'tmp/libsigrokdecode');

mkdirSync(resolve(root, 'tmp'), { recursive: true });
if (existsSync(checkout) && !existsSync(resolve(checkout, '.git'))) {
  rmSync(checkout, { recursive: true, force: true });
}
if (!existsSync(resolve(checkout, '.git'))) {
  console.log(`cloning libsigrokdecode at ${ref} into tmp/libsigrokdecode`);
  execFileSync('git', [
    'clone', '--quiet', 'https://github.com/sigrokproject/libsigrokdecode.git', checkout,
  ], { stdio: 'inherit' });
} else {
  console.log('refreshing tmp/libsigrokdecode');
  execFileSync('git', ['-C', checkout, 'fetch', '--quiet', 'origin'], { stdio: 'inherit' });
}
execFileSync('git', ['-C', checkout, 'checkout', '--quiet', ref], { stdio: 'inherit' });

console.log('staging Pyodide and the sigrok decoder tree');
execFileSync(process.execPath, [
  resolve(root, 'src/decode/tools/vendor-assets.mjs'),
  resolve(checkout, 'decoders'),
], { stdio: 'inherit' });
