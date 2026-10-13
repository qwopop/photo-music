# Vision test fixtures

No API key exists to record live responses, so `responses.json` is hand-written
in the documented Messages API wire format. It holds one valid response and two
non-text content blocks (`thinking`, `fallback`). The tests copy the response
and change its `stop_reason`, its `content`, or the text of the answer to build
every other case. Replacing these with cleaned-up live recordings is #39.

Nothing here is a real response, request ID or personal photo. The test images
are generated in memory with sharp from flat colours, and the tests also read
`lib/upload/fixtures/unsupported.gif` and `lib/palette/fixtures/animated.webp`.
