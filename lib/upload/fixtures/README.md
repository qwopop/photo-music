# Upload test fixtures

`sample.jpg`, `sample.png`, and `sample.webp` are synthetic 4×3 solid blue
images generated with sharp 0.35.5. `unsupported.gif` is a synthetic 1×1 GIF.
They contain no personal photos, metadata, or secrets. The tests decode these
actual files and derive corrupt/oversized cases from them without mocking the
image decoder. The JPEG can also be used for the README's HTTP smoke command.
