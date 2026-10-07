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
| `kobo-seed` | A new Kobo entitlement is seeded from stored reading progress instead of hardcoded zeros. Without it the first sync of an already-started book tells the device the book is at 0%, the device opens at the start and reports a fresh low percentage, and that newer timestamp overwrites the real progress in BookOrbit. |
| `audiobook-assembly` | Lets a request plugin that serves one bare audio file attach the book's details (`PluginReleaseFile.audiobook`). After the direct download finishes, ffmpeg builds an m4b with chapters, series, narrators, tags and cover, stream-copying AAC and transcoding anything else, before the import sees it. Used by `plugins/storytel`. |
| `whats-new` | Pins the patch list to the top of the What's New tab, fed from this manifest at build time. The popup path is untouched and keeps showing upstream releases only. |

Each patch has a matching `*-tests.patch` holding its unit tests. Those are kept for
reference only — the image build applies the code patches alone.

## Storytel plugin

`plugins/storytel/index.mjs` is a request indexer plugin that searches Storytel and downloads
audiobooks from your own subscription. It needs this image for the `audiobook-assembly` patch;
on stock BookOrbit it still downloads, but as a bare MP3 without chapters.

1. Settings > System > Requests > install plugin, and upload `index.mjs` (or copy it to
   `/data/plugins/indexers/storytel/index.mjs` and restart).
2. Add a Storytel indexer: your Storytel password in the API key field, the e-mail, your store
   (`STHP-SE` for Sweden) and the languages to search.
3. Request an audiobook as usual. Picking a Storytel release adds the book to your Storytel
   bookshelf, downloads it, and the import receives an m4b with chapters, series, narrators and cover.

Search uses Storytel's public catalogue and never logs in. The account is only used when a release
is grabbed: one reused session, grabs one at a time, capped per day and spaced out (both
configurable), and an hour's pause after a Cloudflare block or rate limit. That lowers the risk of
Storytel flagging the account; it does not remove it.

`node plugins/storytel/verify.mjs` runs its checks against saved Storytel responses.

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

Images are versioned `<tag>+patches`, e.g. `v2.10.0+patches`. The suffix is deliberately
fixed rather than a list of ids: release-notes validates the running version against
`SEMVER_RE`, whose build-metadata group is `[\w.]+` and so rejects the hyphens in our ids,
and a version that fails it silently disables the check that stops What's New announcing
releases newer than the build you are on. Which patches are actually in an image is
answered by the What's New tab and by `state/last-built.json`.

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
   post-apply assertion. `title` and `description` are what the What's New tab shows, so
   write them for whoever uses this BookOrbit, not for yourself.
4. Verify against a clean checkout: `git -C upstream apply --verbose patches/<id>.patch`.
