# PNG and APNG policy fixtures

Synthetic files built from raw PNG chunks with Node's zlib and CRC APIs. They
contain no personal photos, metadata or secrets. sharp alone accepts and
decodes every one of them (it ignores APNG animation chunks and recovers
pixels from an incomplete PNG); the shared container guard in `../png.ts`
is what rejects them for public upload.

- `missing-iend.png` is `../../upload/fixtures/sample.png` (4×3 blue) with its
  whole 12-byte `IEND` chunk removed, after a complete `IDAT`.
- `truncated-iend.png` is the same image with `IEND`'s length and type but
  without its 4-byte CRC.
- `apng-default-frame.apng` is a valid 2×1 RGBA APNG whose red default `IDAT`
  image is also the first animation frame (`fcTL` before `IDAT`), followed by
  a blue `fdAT` frame. `../../palette/fixtures/default-image.apng` is the other
  arrangement: a separate red fallback default image and a blue animation.
- `apng-missing-controls.apng` has an `acTL` declaring two frames, but no
  `fcTL` or `fdAT` chunk at all.
- `apng-corrupt-later-frame.apng` is like `apng-default-frame.apng`, with
  valid chunk CRCs, but its later `fdAT` data is not a zlib stream.
- `apng-over-aggregate.apng` has two 1-bit grayscale 4000×4000 frames (a black
  default image that is also frame one, then a white `fdAT` frame) in about
  8 KiB. Each frame has 16M pixels, under the 25M limit, but the declared
  animation totals 32M.
