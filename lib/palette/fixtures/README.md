# Palette test fixtures

These are synthetic images generated in memory with sharp 0.35.5 and then
committed for reproducible real-decoder tests. No personal photos or metadata
are used.

- The small lossless PNGs contain exact 8-bit reference colors. `red-dominant`
  is three red pixels and one blue pixel; `six-colors` contains equally weighted
  red, green, blue, cyan, magenta and yellow; `black-white` has equal black/white.
- `hidden-transparent` has hidden red RGB in three transparent pixels and one
  visible green pixel. `partial-alpha` has opaque red and blue at alpha 128.
  `transparent` has only fully transparent pixels with different hidden RGB.
- `near-shades` has two nearby reds in the same five-bit bucket and one blue,
  for meaningful representative-mean and frequency assertions.
- `solid.jpg` and `solid.webp` encode a 16×16 RGB `(204, 102, 34)` image using
  high-quality lossy encoders. Tests allow at most three channel levels of
  decoding error; they do not require lossless equality.
- `animated.webp` has two lossless 2×1 frames, solid red then solid blue.
  Palette assertions select red while invalid-later-frame tests still exercise
  validation of the whole animation.
- `default-image.apng` was built using PNG chunks and Node's zlib/CRC APIs. It
  has a separate red 2×1 default IDAT image and a blue 2×1 animation frame. It
  demonstrates the direct palette utility's documented default-image policy,
  not APNG animation support. Public upload rejects it (#37). More PNG/APNG
  policy fixtures are in `lib/image/fixtures/`.
- `over-pixel-animation.webp` encodes two solid black/white 4000×4000 lossless
  frames in a few KiB. Each frame fits the 25M-pixel limit, while their 32M total
  must reject before pixel decoding. Fixture generation is done once, so this
  boundary check does not allocate or encode its large raw frames in the suite.
