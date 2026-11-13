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
absolute base of `/`. There is no OTA submodule in this fork; the device menu links
to the public Sipeed updater instead. Refer to the workflow for the exact commands.

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
