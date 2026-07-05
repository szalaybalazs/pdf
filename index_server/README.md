# Remote index server

A small, shared home for one or more **libraries** (collections) so several
desktop apps can query and grow the *same* index instead of each keeping a
private copy on local disk.

It wraps the exact `pdf_qa.store.VectorStore` the app uses locally, keeps each
library in memory, and exposes a small HTTP API. Embedding vectors live only
here — clients download compact chunk *metadata* and fetch page images on
demand — so N apps don't each hold the full matrix in RAM, and dense search is a
single vector round-trip resolved by an in-memory matmul.

## Run it

Pull the published image (no build needed):

```bash
docker run -d -p 8000:8000 -v pdf-qa-index:/data \
  ghcr.io/szalaybalazs/pdf-qa-index:latest
# or, with compose:
docker compose -f index_server/docker-compose.yml pull
docker compose -f index_server/docker-compose.yml up -d
```

Or build it locally (the build context must be the project root so the `pdf_qa`
package is included):

```bash
docker build -f index_server/Dockerfile -t pdf-qa-index .
docker run -d -p 8000:8000 -v pdf-qa-index:/data pdf-qa-index
# or: docker compose -f index_server/docker-compose.yml up -d --build
```

## Publishing the image

CI publishes a multi-arch (amd64 + arm64) image to ghcr.io on every `v*` release
tag (and on manual dispatch) — see `.github/workflows/index-server-image.yml`.
Tags pushed: the version (e.g. `0.0.19`), `major.minor`, the commit `sha`, and
`latest`.

To publish by hand (needs a token with `write:packages`):

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u szalaybalazs --password-stdin
docker buildx build --platform linux/amd64,linux/arm64 \
  -f index_server/Dockerfile \
  -t ghcr.io/szalaybalazs/pdf-qa-index:latest \
  -t ghcr.io/szalaybalazs/pdf-qa-index:0.0.19 \
  --push .
```

> ghcr packages are **private** by default. To let anyone pull without
> authenticating, set the package to public in GitHub (Packages → pdf-qa-index →
> Package settings → Change visibility). Otherwise consumers must
> `docker login ghcr.io` with a token that has `read:packages`.

Data persists in the `/data` volume: `/data/<library>/index/{store.npy,store.jsonl,pages/,sources/,manifest.json,embedder.json}`.
(`sources/` holds the original PDFs, uploaded at ingest so any connected app can
render the cited-passage highlight overlay, which re-opens the source file.)

Every server always has a **`default`** library: it's created on startup, always
appears in `/v1/libraries`, and can't be deleted. An app that connects without
naming a library on the server lands here.

### Locally without Docker

```bash
pip install -r index_server/requirements.txt
INDEX_SERVER_DATA_DIR=./srv-data uvicorn server:app --app-dir index_server --host 0.0.0.0 --port 8000
```

## Authentication

A single shared secret, set with `INDEX_SERVER_SECRET`:

- **Set** → every request must send `Authorization: Bearer <secret>` (the app
  stores this per remote library). `/health` is always open so the app's
  "Test connection" works.
- **Empty / unset** → the server is **open**: any request is allowed.

```bash
docker run -d -p 8000:8000 -e INDEX_SERVER_SECRET=change-me -v pdf-qa-index-data:/data pdf-qa-index
```

> The secret is basic access control, not transport security. Put the server
> behind TLS (a reverse proxy) if it's reachable over an untrusted network.

## Connecting from the app

**New Library → Remote**, then enter the server URL (e.g. `http://localhost:8000`),
the secret (blank for an open server), and optionally the library name on the
server (defaults to the library's name in the app). "Add PDFs" then ingests
locally and pushes the result to the server; other connected apps see it after
their next reload.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness (no auth) |
| GET | `/v1/libraries` | List libraries + doc/chunk counts |
| POST | `/v1/libraries/{lib}` | Create an empty library |
| DELETE | `/v1/libraries/{lib}` | Delete a library |
| GET | `/v1/libraries/{lib}/info` | docs, chunks, embedder |
| GET | `/v1/libraries/{lib}/chunks` | All chunk metadata (client cache) |
| POST | `/v1/libraries/{lib}/search` | Dense cosine `{vector, dim, top_k, docs?}` |
| POST | `/v1/libraries/{lib}/add` | Append `{chunks, vectors, dim, embedder?}` |
| POST | `/v1/libraries/{lib}/remove_doc` | Drop a document `{doc}` |
| GET/PUT | `/v1/libraries/{lib}/manifest` | Content-hash manifest (skip-unchanged) |
| GET/POST | `/v1/libraries/{lib}/pages/{path}` | Fetch / upload a page PNG |
| GET/POST | `/v1/libraries/{lib}/source/{name}` | Fetch / upload the original PDF (for the highlight overlay) |

Vectors travel as base64 of raw little-endian float32 bytes plus an explicit
`dim`.
