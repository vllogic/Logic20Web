// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/ota', import.meta.url));

export default defineConfig({
  root,
  // Deployed at https://logic20.vllogic.com/ota/. Keep every asset under it.
  base: '/ota/',
  publicDir: 'public',
  server: {
    port: 5175,
    strictPort: true,
    // The page imports the protocol modules from <repo>/src/device/iap.
    fs: { allow: [repo] },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
