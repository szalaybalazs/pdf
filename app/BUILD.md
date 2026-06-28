# Building, signing & releasing PDF QA

The desktop app ships as a signed/notarized installer for **macOS** and
**Windows**, with **auto-updates** delivered from an **S3** bucket. The Python
backend is frozen with PyInstaller and bundled inside the app, so end users need
neither Python nor the project source.

```
 ┌─ scripts/build-backend.sh ─┐   ┌──────── app/ (electron-builder) ────────┐
 │ PyInstaller freezes        │   │ tsc + esbuild build the Electron app    │
 │ backend_entry.py  ───────► │   │ electron-builder packages + signs +     │
 │ app/backend-dist/          │──►│ notarizes, then uploads to S3 with      │
 └────────────────────────────┘   │ latest*.yml update manifests            │
                                   └──────────────────────────────────────────┘
```

## One-time prerequisites

### Python build env (for the frozen backend)
```bash
cd <project root>
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt pyinstaller
```

### Bundled Tesseract (OCR engine)
`build:backend` runs `scripts/vendor-tesseract.sh`, which stages a self-contained
Tesseract next to the frozen backend (`app/backend-dist/tesseract/`) so OCR works
with **no system install** on the user's machine. It vendors only for the host
platform (PyInstaller can't cross-compile anyway):

- **macOS** — uses Homebrew + `dylibbundler` (both auto-installed if missing),
  relocating dylibs to `@executable_path/libs`. The engine is signed/notarized as
  part of the normal `electron-builder` pass (it lives under `Contents/Resources`).
- **Windows** — downloads the pinned UB-Mannheim installer and extracts it with
  **7-Zip**, which must be on PATH (`choco install 7zip` or `winget install 7zip.7zip`).
  Bump the version via `WIN_TESS_VERSION` / `WIN_TESS_URL`.

Languages bundled default to `eng osd`; override with `PDF_QA_BUNDLE_LANGS="eng deu …"`
(must match `OCR_LANG` at runtime). Set `PDF_QA_SKIP_TESSERACT=1` to skip vendoring
(OCR then falls back to a system `tesseract` on PATH, if any).

### macOS code-signing & notarization
You need an Apple Developer account and a **Developer ID Application** certificate.

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path or base64 of the Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (appleid.apple.com → Sign-In & Security) |
| `APPLE_TEAM_ID` | Your 10-char Apple Team ID |

When all of `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` are set,
electron-builder notarizes automatically (via `notarytool`) because
`mac.notarize: true` in `electron-builder.yml`. The hardened-runtime
entitlements live in `build/entitlements.mac.plist` (they allow the app to spawn
the frozen Python binary).

> Building locally with no `CSC_LINK`? electron-builder falls back to a Developer
> ID identity already in your login keychain.

### Windows code-signing
| Env var | Purpose |
|---|---|
| `WIN_CSC_LINK` | Path or base64 of the code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Password for that `.pfx` |

(For EV / Azure Trusted Signing, configure `win.signtoolOptions` per the
electron-builder docs instead.) Windows builds are produced on a Windows machine
or CI runner — cross-compiling the frozen Python backend is not supported.

### S3 bucket
This app publishes to a **shared** bucket, namespaced by a per-app key prefix so
multiple apps can live side by side without their `latest*.yml` manifests
colliding:

```
s3://desktop-electron-app-updates/   (region eu-central-1)
  └── pdf-qa/                         ← publish[0].path
        ├── latest-mac.yml
        ├── latest.yml
        ├── PDF QA-<version>-arm64.dmg / .zip
        └── PDF QA-Setup-<version>.exe
```

1. Bucket `desktop-electron-app-updates` in `eu-central-1` (already set in
   `electron-builder.yml`). Each additional app just changes `path:` to its own
   name.
2. Credentials come from the **`personal`** AWS profile — the `publish` script
   sets `AWS_PROFILE=personal` for you, so just have that profile configured in
   `~/.aws/credentials` (or `~/.aws/config`). To use a different profile, set
   `AWS_PROFILE` in the environment (it overrides) or edit the `publish` script.
   **Scope the publishing principal to this app's prefix** so one app's CI can't
   clobber another's releases:
   ```json
   [
     {
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
       "Resource": [
         "arn:aws:s3:::desktop-electron-app-updates",
         "arn:aws:s3:::desktop-electron-app-updates/pdf-qa/*"
       ]
     },
     {
       "Effect": "Allow",
       "Action": "cloudfront:CreateInvalidation",
       "Resource": "arn:aws:cloudfront::<acct-id>:distribution/E6428K3WFUDSE"
     }
   ]
   ```
   The CloudFront permission is for the post-publish cache invalidation (below).
3. The shipped app does **not** read S3 directly. It downloads updates over
   HTTPS from `https://update.szalay.me/pdf-qa/…`, a CloudFront distribution in
   front of the (private) bucket. See **Custom domain** below.

### Custom domain (update.szalay.me → CloudFront → S3)

The bucket stays private; CloudFront serves it over `update.szalay.me` so the
updater fetches `https://update.szalay.me/pdf-qa/latest-mac.yml` etc. The S3 key
prefix becomes the URL path, so every app on the bucket gets its own URL prefix
(`/pdf-qa`, `/other-app`, …) under the one domain + one distribution.

One-time AWS setup (Console or CLI):

1. **ACM certificate** — request a public cert for `update.szalay.me` in
   **us-east-1** (CloudFront only reads certs from us-east-1, regardless of the
   bucket's region). Validate it via DNS (add the CNAME ACM gives you).
2. **CloudFront distribution**:
   - **Origin**: the `desktop-electron-app-updates` S3 bucket, using **Origin
     Access Control (OAC)** — not "public". Leave *Origin path* empty so the
     bucket root maps to the domain root.
   - **Alternate domain name (CNAME)**: `update.szalay.me`; attach the ACM cert.
   - **Default behavior**: allow `GET, HEAD`; Redirect HTTP→HTTPS; a caching
     policy is fine for the installers (they're immutable, versioned filenames).
   - The `latest*.yml` manifests are overwritten each release, so they must not
     be served stale. This is handled by an **automatic CloudFront invalidation**
     after every publish (see Release steps) — `scripts/invalidate-cloudfront.sh`
     invalidates `/pdf-qa/*`. As a belt-and-braces alternative you can also add a
     `*.yml` behavior with `CachingDisabled`, but the invalidation alone is enough.
3. **Bucket policy** — when you create the OAC, CloudFront gives you the policy
   to paste. It grants only the distribution `s3:GetObject`:
   ```json
   {
     "Effect": "Allow",
     "Principal": { "Service": "cloudfront.amazonaws.com" },
     "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::desktop-electron-app-updates/*",
     "Condition": { "StringEquals": {
       "AWS:SourceArn": "arn:aws:cloudfront::<acct-id>:distribution/<dist-id>" } }
   }
   ```
4. **DNS** — add `update.szalay.me` pointing at the distribution's
   `dxxxx.cloudfront.net` domain. On Route 53: an **A/AAAA Alias** record to the
   distribution. On any other DNS provider: a **CNAME** (works because it's a
   subdomain, not the apex).

After this, `npm run publish` uploads to S3 and `update.szalay.me/pdf-qa/…` serves
it. To verify: `curl -I https://update.szalay.me/pdf-qa/latest-mac.yml` → `200`.

> Bucket region is `eu-central-1`; the ACM cert must still be `us-east-1`. These
> are independent — don't move the bucket.

## Release steps

```bash
# 1. Bump the version (this is what the updater compares against)
cd app && npm version patch        # or minor/major

# 2. Freeze the Python backend for THIS platform → app/backend-dist/
npm run build:backend

# 3. Build + sign + notarize + upload to S3, then invalidate CloudFront
npm run publish                    # electron-builder --publish always && invalidate
```

`npm run publish` ends by running `scripts/invalidate-cloudfront.sh` (the
`invalidate` script) so the new `latest*.yml` is served immediately rather than
from CloudFront's cache. To invalidate manually: `npm run invalidate`. CI does
the same step after its publish (see `.github/workflows/release.yml`).

Per-platform installers without uploading:
```bash
npm run dist:mac      # release/*.dmg + *.zip
npm run dist:win      # release/*Setup*.exe   (run on Windows)
npm run dist          # current OS only, no upload
```

Build the macOS artifacts on macOS and the Windows artifacts on Windows, each
after running `npm run build:backend` on that same OS (the frozen backend is
native code — PyInstaller cannot cross-compile, so you **cannot** build the
Windows `.exe` on a Mac). Run `npm run publish` on each so both platforms'
installers and manifests land in the same S3 path.

## Releasing from CI (recommended — builds both OSes)

`.github/workflows/release.yml` builds, signs/notarizes and publishes **macOS
(arm64)** and **Windows (x64)** on a version tag — no Windows machine needed.

```bash
cd app && npm version patch        # bumps package.json AND creates the git tag
cd .. && git push --follow-tags    # the v* tag triggers the workflow
```

(`workflow_dispatch` also lets you run it manually from the Actions tab.)

Add these repository **Secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM keys scoped to `…/pdf-qa/*` (see S3 section) |
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization (notarytool) |
| `WIN_CSC_LINK` | base64 of the Windows `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | password for that `.pfx` |

> CI uses these AWS *keys* instead of the `personal` profile (the workflow calls
> `electron-builder` directly, bypassing the `AWS_PROFILE=personal` that the
> local `npm run publish` sets).
>
> Intel Macs aren't built (arm64 only). To add them, see the comment in the
> matrix — both mac jobs would write `latest-mac.yml`, so they'd need merging.
> **EV** Windows certs (hardware token) can't run in CI — build those locally.

## How auto-update works at runtime
- `src/updater.ts` runs only in a packaged build (`app.isPackaged`).
- ~3s after launch it asks the S3 feed (`latest-mac.yml` / `latest.yml`) for a
  newer version, downloads it in the background, and then shows a native
  "Restart now / Later" dialog. Declining still installs on next quit.
- All update activity is logged to `<userData>/main.log`.
- macOS updates **require the app to be signed** — an unsigned/ad-hoc build will
  download the update but refuse to apply it.

## Notes / TODO
- **App icons**: none are committed yet. Add `build/icon.icns` (mac) and
  `build/icon.ico` (win, 256×256) — electron-builder picks them up from
  `directories.buildResources` automatically.
- **Tesseract** (OCR fallback) is an external binary the frozen backend does not
  bundle; OCR is skipped on machines without it. Bundle it separately if OCR is
  required for end users.
