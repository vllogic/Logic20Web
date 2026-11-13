# Deploying to Cloudflare Workers

This repository is set up for **Cloudflare Workers Builds** with static assets.
The default Workers Builds configuration works without a custom build script:

| Setting | Value |
| --- | --- |
| Project name | `logic20web` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` |
| Start preview builds | on |
| Root directory | `/` |
| Node version | 22 |

`wrangler.toml` points Wrangler at the built site:

```toml
name = "logic20web"
compatibility_date = "2026-11-13"

[assets]
directory = "./dist"
```

`npx wrangler deploy` uploads `dist/` as a static-assets Worker. No `main`
Worker script is required.

## What `npm run build` does

`npm run build` runs the `prebuild` hook
(`scripts/prepare-runtime-assets.mjs`) and then `tsc --noEmit && vite build`:

1. If `node_modules` is missing, run `npm ci --include=dev` (Workers Builds may
   not install dependencies before the build command).
2. If `public/pyodide/` or `public/decoders/decoders.zip` is missing, clone the
   pinned libsigrokdecode revision into `tmp/libsigrokdecode`, then run
   `src/decode/tools/vendor-assets.mjs`. `zip` is optional; the vendor script
   falls back to Python's `zipfile`.
3. Build with `base: '/'`, because the custom domain serves the site at the root.
   The decode worker resolves Pyodide/decoders from `import.meta.env.BASE_URL`;
   a relative base would resolve inside its blob worker and 404.

A local tree that already has the runtime assets pays no clone cost.

## One-time setup

1. Push the repository to GitHub/GitLab.
2. In Cloudflare Dashboard open **Workers & Pages -> Create -> Workers ->
   Connect to Git**, authorize the repository, and select it.
3. Fill in the default settings above. Add these environment variables if the
   dashboard does not inherit `.nvmrc`:

   ```text
   NODE_VERSION=22
   LIBSIGROKDECODE_REF=71f451443029322d57376214c330b518efd84f88
   ```

   `LIBSIGROKDECODE_REF` is optional; the prebuild script uses the same pinned
   revision as its default.
4. Save and deploy. The first build installs dependencies, vendors Pyodide and
   the decoder tree, builds `dist/`, and `wrangler deploy` publishes it.

## Automatic updates

With Git integration enabled, every push to the production branch (`main`)
starts a new build and deploys on success. Other branches get preview builds
when **Start preview builds** is enabled; `npx wrangler preview` creates the
preview deployment.

## Custom domain

Open the Worker project -> **Settings -> Domains & Routes -> Add -> Custom
domain** and enter the domain. The zone must be in the same Cloudflare account;
Cloudflare creates the DNS record and certificate automatically. If the domain
is hosted elsewhere, move the zone to Cloudflare or use the generated
`<project>.<account>.workers.dev` address first.

WebUSB needs HTTPS; the custom domain provides it.

## Headers and caching

`public/_headers` is copied into `dist/` and applied by Workers static assets:

- `/assets/*`, `/pyodide/*`, `/decoders/*`: one-year immutable cache
  (content-hashed names).
- `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`: `no-cache`.
- COOP/COEP make `crossOriginIsolated` true, so the decode worker can use
  `SharedArrayBuffer`. Remove those two lines only if a future third-party embed
  cannot satisfy CORP.

## Verify

```text
https://<domain>/                 # UI boots, no console 404s
https://<domain>/sw.js            # text/javascript, no-cache
https://<domain>/pyodide/...wasm  # application/wasm
```

Open the site in Chromium, click **Connect**, select the Logic20, choose 20 CH
and 80/100 MHz, and capture. `chrome://usb-internals` should list `1209:6688`
on the machine doing the capture.

## Troubleshooting

- **A push does not start a build** — the Workers Builds project must have
  `vllogic/Logic20Web` as its Git repository, `main` as its production branch and
  automatic deployments enabled. The Cloudflare GitHub App also needs repository
  access under `https://github.com/settings/installations`. If the project was
  created by a direct `wrangler deploy`, it has no Git trigger at all.
- **`npm run build` cannot find `tsc`/`vite`** — the prebuild hook installs
  dependencies when `node_modules` is missing; if the log shows `npm ci` failing,
  check the build environment's npm registry access.
- **`git clone` of libsigrokdecode fails** — the build needs outbound network.
  Pin `LIBSIGROKDECODE_REF` and retry; a transient GitHub failure is the usual
  cause.
- **Pyodide never warms up** — the host must serve `.wasm` as
  `application/wasm`. Workers static assets does this by extension; a proxy in
  front must preserve it.
- **`crossOriginIsolated` is false** — `_headers` was not applied, or the site is
  served from a path that does not match `/*`.
- **Decoder list and zip disagree** — `LIBSIGROKDECODE_REF` changed without
  committing the regenerated `src/decode/decoders/manifest.ts`.
- **Stale page after deploy** — purge `/` and `/sw.js`; hashed assets are safe.

## Cloudflare Pages alternative

If the project is created as Pages instead of Workers, use:

```text
Build command:  bash scripts/cloudflare-build.sh
Output directory: dist
```

`scripts/cloudflare-build.sh` runs `npm ci --include=dev && npm run build`; the
prebuild hook does the same vendoring. The `wrangler.toml` assets section is
ignored by Pages.
