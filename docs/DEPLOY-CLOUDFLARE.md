# Deploying to Cloudflare Pages

Cloudflare Pages can build this repository on every push and serve the result from
a custom domain. WebUSB needs HTTPS, which Pages provides automatically.

## One-time project setup

1. Push this repository to GitHub/GitLab (the current remote is
   `git@github.com:vllogic/Logic20Web.git`).
2. In the Cloudflare dashboard open **Workers & Pages -> Create -> Pages ->
   Connect to Git**, authorize the repository and select it.
3. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | None |
   | Build command | `bash scripts/cloudflare-build.sh` |
   | Build output directory | `dist` |
   | Root directory | `/` (repository root) |
   | Node version | 22 (also recorded in `.nvmrc`) |

   Environment variables (optional but recommended):

   | Variable | Value |
   | --- | --- |
   | `NODE_VERSION` | `22` |
   | `LIBSIGROKDECODE_REF` | a libsigrokdecode commit SHA, e.g. `71f451443029322d57376214c330b518efd84f88` |

4. Advanced settings — most fields stay at their defaults:

   | Field | Value |
   | --- | --- |
   | Root directory | `/` (repository root) |
   | Build image | latest v2/v3 |
   | Deploy command | leave empty (Pages Git integration deploys `dist/`) |
   | Submodules | **off** — `sub_service/ota` uses an SSH URL and is not staged here |
   | Preview deployments | on if preview URLs are wanted; otherwise production only |
   | Build watch paths | leave default (all paths); docs-only pushes then rebuild too |
   | Compatibility flags/date | leave default; there are no Pages Functions |

   `NODE_VERSION=22` and `LIBSIGROKDECODE_REF` are the only environment variables
   that matter. The build script runs `npm ci --include=dev`, so a Cloudflare
   `NODE_ENV=production` cannot omit TypeScript/Vite.

5. Click **Save and Deploy**. The first build clones libsigrokdecode, runs
   `npm ci`, vendors Pyodide and the decoder tree, and builds `dist/`.

## What the build command does

`scripts/cloudflare-build.sh` runs:

```bash
npm ci
git clone https://github.com/sigrokproject/libsigrokdecode.git /tmp/libsigrokdecode
git -C /tmp/libsigrokdecode checkout <LIBSIGROKDECODE_REF>
npm run vendor -- /tmp/libsigrokdecode/decoders
npm run build -- --base=/
```

- Pyodide comes from `node_modules/pyodide`; the 13 MB runtime is never committed.
- The decoder tree is cloned and zipped at build time. `zip` is optional: the
  vendor script falls back to Python's `zipfile` if the image has `python3` only.
- `--base=/` is required for a custom-domain root. The decode worker resolves
  Pyodide and `decoders.zip` from `import.meta.env.BASE_URL`; a relative `./`
  base would resolve inside the blob worker and 404.
- The OTA update pages (`sub_service/ota`) are not staged here. Add a
  `git submodule update --init sub_service/ota` plus the staging step from
  `.github/workflows/deploy-pages.yml` if the Cloudflare site should also host
  `/ota/`.

## Custom domain

In the Pages project open **Custom domains -> Set up a custom domain** and enter
the domain. If the domain's DNS is already on Cloudflare, Pages creates the
required CNAME automatically. For an external DNS provider, point a CNAME at
`<project>.pages.dev` (or use the CNAME target Pages shows).

Cloudflare issues the TLS certificate. No `public/CNAME` is needed for Pages;
the existing file is for GitHub Pages and is harmless in the build output.

## Automatic updates

With Git integration enabled, every push to the production branch (`main`)
starts a new build and deploys on success. Other branches and pull requests get
preview deployments with their own `*.pages.dev` URLs.

The current cache policy is in `public/_headers`:

- `/assets/*`, `/pyodide/*`, `/decoders/*`: immutable, one year (content-hashed).
- `/index.html`, `/sw.js`, `/manifest.webmanifest`: `no-cache`.
- COOP/COEP enable `crossOriginIsolated` and `SharedArrayBuffer` for the decode
  worker. If a future third-party embed cannot satisfy CORP, remove those two
  lines; the app still works without them.

## Verify after the first deploy

```text
https://<your-domain>/              # UI boots, no console 404s
https://<your-domain>/sw.js         # service worker, text/javascript
https://<your-domain>/pyodide/...   # application/wasm for the .wasm file
```

Open the page in Chromium, click **Connect**, select the Logic20, choose 20 CH
and 80/100 MHz, and capture. `chrome://usb-internals` should list `1209:6688`
on the machine doing the capture.

## Troubleshooting

- **Build fails in `npm run vendor`** — check the log for a missing `python3`
  or `git`. The vendor script needs `python3` for the decoder manifest; `zip`
  has a Python fallback.
- **Pyodide never warms up** — the host must serve `.wasm` as
  `application/wasm`. Cloudflare does this by extension; a custom proxy in front
  of Pages must preserve it.
- **`crossOriginIsolated` is false** — something stripped the COOP/COEP headers
  from `_headers`, or the page is served from a path that does not match `/*`.
- **Decoder list and zip disagree** — `LIBSIGROKDECODE_REF` changed without
  re-vendoring the committed `src/decode/decoders/manifest.ts`. The build
  regenerates it, so commit that change with the decoder bump.
- **Stale entry page after deploy** — purge `/index.html` and `/sw.js` at the
  CDN, or wait for the `no-cache` policy; hashed assets are safe to keep.
