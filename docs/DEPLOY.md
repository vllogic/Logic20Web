<!-- Copyright (C) 2026 vllogic.com -->

# Deployment

[The deployment workflow](../.github/workflows/deploy-pages.yml) builds on pushes to
`main` and publishes the same artifact to GitHub Pages and Qiniu. It includes the
analyzer, decoder runtime and offline shell. Build output is not committed.

## Configuration

- Set GitHub Pages to **GitHub Actions** and allow deployments from `main`.
- Set the repository variable `QINIU_BUCKET` to a public-read bucket in the uploader's
  supported region (`z2`).
- Add repository secrets `QINIU_ACCESS_KEY` and `QINIU_SECRET_KEY`.

The workflow vendors runtime assets, runs checks, and builds the analyzer with an
absolute base of `/`. The firmware-update page is built by the same command's
`postbuild` hook; see below. Refer to the workflow for the exact commands.

## The firmware-update page under `/ota/`

`npm run build` runs `scripts/build-ota.mjs` after the analyzer build. It does two
things:

1. Regenerates `ota/public/firmware.json` from the `.iap` package(s) in
   `ota/public/firmware/`: the package is decrypted with its public IAP key and the
   info block, code CRC and FPGA-data CRC are verified. Version, build date, lengths,
   block count and SHA-256 in the manifest therefore come from the package itself.
2. Builds the standalone page with `ota/vite.config.ts` into `dist/ota/`, with base
   `/ota/`.

The page is deployed at `https://logic20.vllogic.com/ota/`. It loads the bundled release
package by default and also accepts a local `.iap` (the bundled box reappears after a
local selection, to switch back). It shares the protocol modules in `src/device/iap/`
with the analyzer, but no analyzer UI, worker or store: the `/ota/` bundle is
independent and the service worker does not intercept it.

To publish a new firmware, replace the `.iap` under `ota/public/firmware/` and run
`npm run build` (or `npm run ota:manifest` to regenerate only the manifest). Deleting
all packages fails the build rather than publishing a page with a stale manifest.

The page also shows the info block's `code_hash` / `data_hash` fields. Each is eight
bytes: a seven-character git hash plus `C` (clean) or `D` (dirty). The bundled release
carries `a855b02C` / `47357b4C`. A new package must write those fields (the manifest is
generated from them); leaving them zero shows "未记录" and loses the build traceability.

`SLOGICWEB_PORTABLE=1` skips the step: the portable single-file artifact must have
nothing beside `index.html`. `npm run dev:ota` serves the page on port 5175 for local
work.

## Hosting requirements

- Use HTTPS for WebUSB. Serve `.wasm` as `application/wasm` and JavaScript modules
  with a JavaScript MIME type.
- Keep HTML, `sw.js`, manifests, and other mutable entry points fresh. Content-hashed
  assets may be cached; retain old hashed files so open tabs remain usable.
- Missing assets must return 404; the app has no client-side path routes that need an
  HTML fallback.

[The publisher](../.github/scripts/upload-qiniu.mjs) uploads resources before HTML
and the service worker, then the workflow refreshes and verifies CDN content.
Incomplete uploads fail the job.

## Verification

```sh
node --test .github/scripts/upload-qiniu.test.mjs
```

Before publishing, check that the analyzer loads, decoder assets have the correct MIME
types, and refreshed entry points match the build artifact.
