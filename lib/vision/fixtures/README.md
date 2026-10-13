# Vision test fixtures

Synthetic files only: no personal photos, no real API responses and no real
request IDs. No API key exists to record live responses (live checks are #39).

- `oriented-gps.jpg` is a 40x20 JPEG, left half red and right half blue, stored
  with EXIF orientation 6 (rotate 90 degrees clockwise), fake GPS EXIF data, an
  EXIF copyright string and an XMP packet. Prepared for analysis it must be
  upright at 20x40 (red on top, blue at the bottom) with no metadata.
- `response-*.json` are hand-written Messages API responses in the documented
  wire format, replayed by the tests through an injected `fetch`:
  - `end-turn` has one text block with valid mood JSON.
  - `with-thinking` and `with-fallback` put a `thinking` block or a server-side
    `fallback` block before the same text block.
  - `refusal` has `stop_reason: "refusal"` and empty `content`.
  - `max-tokens` has cut-off JSON and `stop_reason: "max_tokens"`.
  - `not-json` has a text block that is not JSON.
  - `no-text` has only a `thinking` block, and `empty-content` has no blocks.

Other test inputs are read from `../../upload/fixtures/unsupported.gif` and
`../../palette/fixtures/animated.webp`. Large and oversized images are generated
inside the tests.
