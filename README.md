# bookorbit-patched

BookOrbit release images rebuilt with fixes that upstream has not shipped yet. Everything
else is untouched: same Dockerfile, same source, same release tags.

## Image

```text
ghcr.io/secunit404/bookorbit-patched:release   # moving tag, latest patched release
ghcr.io/secunit404/bookorbit-patched:v2.10.0   # one tag per upstream release
```

## Patches

`patches/manifest.json` is the source of truth. Each entry names the patch, the file it
touches, and a `marker` string whose presence in that file means the change is already
there.

| id | what it fixes |
|---|---|
| `qbt-cookie` | The qBittorrent download client also accepts the `QBT_SID_<port>` session cookie that qBittorrent 5.2+ sends. Without it every call after a successful login is answered with `403`, and BookOrbit reports `qBittorrent answered 403 for /api/v2/app/version`. |
| `kobo-seed` | A new Kobo entitlement is seeded from stored reading progress instead of hardcoded zeros. Without it the first sync of an already-started book tells the device the book is at 0%, the device opens at the start and reports a fresh low percentage, and that newer timestamp overwrites the real progress in BookOrbit. |

Each patch has a matching `*-tests.patch` holding its unit tests. Those are kept for
reference only — the image build applies the code patches alone.

## How it builds

A daily workflow looks up the newest upstream release and applies each patch in manifest
order:

- **Marker already present** — upstream ships that fix, so the patch is skipped and the
  build continues with the rest.
- **Patch does not apply** — hard failure. Shipping an unpatched image under a tag that
  claims to be patched is the one outcome this repository exists to prevent, so a stale
  patch stops the build instead of being silently dropped.
- **Every patch obsolete** — nothing is built, and the run summary says to switch back to
  `ghcr.io/bookorbit/bookorbit` and archive this repository.

The applied patch ids become the version suffix, so `v2.10.0+qbt-cookie.kobo-seed` tells
you exactly what went into an image.

A release is rebuilt when its image is missing *or* when the patch set changed since that
image was built — `state/last-built.json` records the fingerprint. Adding or editing a
patch therefore rebuilds the current release on the next run rather than leaving the tag
pointing at an image without it. `workflow_dispatch` can also force a rebuild, or build a
specific upstream tag.

## Adding a patch

1. Check out the upstream release, make the change, and confirm it with
   `pnpm type-check`, `pnpm lint:check` and the relevant `vitest` run.
2. `git diff -- <changed files> > patches/<id>.patch`, and the tests separately as
   `patches/<id>-tests.patch`.
3. Add an entry to `patches/manifest.json`. Pick a `marker` that is absent upstream and
   present after the patch applies — it serves as both the obsolescence check and the
   post-apply assertion.
4. Verify against a clean checkout: `git -C upstream apply --verbose patches/<id>.patch`.
