# Spotify fixtures

These JSON files are written by hand from Spotify's documented response shape.
They are not recorded from the live API, and they contain no real token.
Issue #51 replaces them with recorded responses.

- `token.json`: a client credentials token response.
- `search-mixed.json`: a search response with valid and bad items (a `null` item, a bad id, no images, no album name).
- `search-empty.json`: a search response with no items.
