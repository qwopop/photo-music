# Backlog

Project: a website where a user uploads a photo, gets its musical mood, a featured song, a playlist (Spotify/YouTube links), and Instagram captions. Stack: Next.js (App Router) + TypeScript + PostgreSQL. Tasks are ordered roughly by dependency, but each one states what it assumes so it can be handed over on its own.

## 1. Set up an empty project with a passing test
Goal: Have a runnable Next.js + TypeScript project with a test runner and one passing test.
Description: Create a new Next.js (App Router) project with TypeScript, ESLint, and a test runner such as Vitest. Add a single trivial test (for example, a function that returns a greeting) and an `npm test` script that passes. Document the install, dev, and test commands in a README.

## 2. Add a continuous integration workflow
Goal: Run lint, type-check, and tests automatically on every push and pull request.
Description: Add a GitHub Actions workflow for a Node.js project that installs dependencies, then runs lint, `tsc --noEmit`, and the test script. It should fail the build if any step fails. Assumes the repo has `lint`, `typecheck`, and `test` npm scripts; add the missing ones if needed.

## 3. Configure environment variables and secrets handling
Goal: Load and validate all configuration from environment variables in one place.
Description: Create a typed config module (for example with zod) that reads and validates variables such as the database URL, vision API key, Spotify and YouTube credentials, and storage settings. Fail fast with a clear message when a required value is missing. Add a `.env.example` listing every variable and make sure `.env*` files are git-ignored.

## 4. Set up PostgreSQL locally with Docker Compose
Goal: Start a local PostgreSQL database with a single command.
Description: Add a `docker-compose.yml` that runs PostgreSQL with a named volume and default development credentials. Document how to start it and which connection string to use in `.env`. Add a small script or test that confirms the app can connect.

## 5. Add the database layer and schema for users and sessions
Goal: Define the first database tables and migrations using an ORM.
Description: Add Prisma or Drizzle to a Next.js + PostgreSQL project and create migrations for `users` (id, email, password hash, created at) and any session or account tables the chosen auth library needs. Include a command to run migrations and a test that applies them to a test database. Assumes a reachable PostgreSQL instance.

## 6. Implement email and password sign-up and login
Goal: Let a visitor create an account and sign in with email and password.
Description: Use Auth.js (or an equivalent) in a Next.js app with a PostgreSQL `users` table to implement registration, login, and logout with hashed passwords (argon2 or bcrypt) and secure cookie sessions. Include basic validation and error messages for duplicate emails and wrong credentials. Add tests for the registration and login logic.

## 7. Build the landing page and photo upload form
Goal: Show a page where a user can choose a photo and see a preview before submitting.
Description: Create the home page with a file picker and drag-and-drop area for JPEG, PNG, and WebP images, plus a client-side preview and a submit button. Validate type and size (for example, 10 MB maximum) in the browser and show clear errors. The submit action can call a stub for now; it does not need a working backend.

## 8. Create the upload API route with server-side validation
Goal: Accept an image upload on the server and reject invalid files.
Description: Add a Next.js route handler that accepts a multipart image upload, checks the real file type from its contents (not just the extension), enforces a size limit, and returns a temporary in-memory or temp-file handle. Return structured JSON errors for unsupported or oversized files. Write tests for valid, oversized, and wrongly typed uploads.

## 9. Extract a dominant color palette from a photo
Goal: Produce a list of dominant colors from an image to theme the results page.
Description: Write a server-side function that takes an image buffer and returns five to six dominant colors as hex values, plus a simple measure of brightness. Use a library such as sharp or node-vibrant. Cover it with tests using small fixture images.

## 10. Define the mood data model and JSON schema
Goal: Agree on the structured format that describes a photo's mood.
Description: Define TypeScript types and a zod schema for a mood result: one primary emotion (happy, sad, calm, energetic, romantic), up to three secondary moods (free-form tags such as nostalgic or dreamy), a short explanation, and a confidence value. Add example fixtures and validation tests. This schema is the contract other tasks will rely on.

## 11. Integrate a vision AI model to analyze photo mood
Goal: Turn an uploaded image into a validated mood result.
Description: Write a server module that sends an image to a hosted vision model with a prompt asking about scenery, color, lighting, and atmosphere, and requests output matching the mood schema (primary emotion, secondary moods, explanation). Validate the response and handle failures and malformed output with a clear error. Put the client behind an interface so tests can use a fake implementation.

## 12. Expose the photo analysis endpoint
Goal: Provide an API route that returns mood and palette for an uploaded photo.
Description: Add a route that accepts an image, runs the palette extraction and the mood analysis, and returns both as JSON. Add per-IP rate limiting to protect the paid vision API. Tests should use a fake analyzer and check the response shape and the rate-limit behavior.

## 13. Create the mood results page
Goal: Display the detected mood, explanation, and palette on a results page.
Description: Build a page that renders the primary emotion, secondary moods, the atmosphere explanation, and the photo, using the extracted colors for the background and accents. Present the mood as an interpretation rather than a fact. Use fixture data so the page works without a backend.

## 14. Add mood correction on the results page
Goal: Let the user override the detected mood and re-run recommendations.
Description: Add controls to pick a different primary emotion and secondary moods from a fixed list, producing an updated mood object in the same schema. The correction should not trigger another vision API call. Include component tests for selecting and applying a correction.

## 15. Build a preferences form
Goal: Collect the user's music taste and optional situation.
Description: Create a form for genres (multi-select), favorite artists (free text tags), languages (multi-select), an optional situation (studying, walking at night, relaxing, driving, none), and playlist length (5, 10, 20, 30). Output a typed preferences object with validation. The form should work standalone and keep its values in the URL or local state.

## 16. Design the track and playlist data model
Goal: Define the shared shape for recommended tracks and playlists.
Description: Define types and zod schemas for a track (title, artist, album, duration, Spotify URL and ID, YouTube URL, cover image, a match reason) and a playlist (list of tracks, a featured track, and the mood and preferences used). Add fixtures and validation tests. This is the contract between the recommendation logic and the UI.

## 17. Integrate the Spotify Web API for track search
Goal: Look up real tracks on Spotify.
Description: Write a server module that authenticates with Spotify using the client credentials flow, caches the token, and searches for tracks by query, genre, or artist, returning the track schema. Handle rate limits and API errors gracefully. Before building, check which Spotify endpoints are currently available to new apps, since some (audio features, recommendations) have been restricted.

## 18. Integrate the YouTube Data API for video links
Goal: Find a YouTube video link for a given track.
Description: Write a server module that searches the YouTube Data API for a song by title and artist and returns the best matching video URL. Cache results in memory or the database because of the daily quota, and fall back to a plain YouTube search link when the API fails or the quota is exhausted. Test with a mocked HTTP client.

## 19. Map moods and situations to music search criteria
Goal: Convert mood tags, preferences, and situation into search criteria.
Description: Write a pure function that takes a mood object and a preferences object and returns weighted criteria such as target genres, energy level, tempo range, and search keywords. Photo mood has the highest weight, then music preferences, then the situation. Make it easy to read and fully unit tested, with no network calls.

## 20. Build the playlist recommendation engine
Goal: Produce a ranked playlist with a featured song from mood and preferences.
Description: Combine the criteria mapping with a track search provider to gather candidates, remove duplicates, rank them, and return a playlist of the requested length with a featured track and a short reason per track. Never invent tracks: return only items the music provider actually returned. Depends on a search interface that tests can replace with a fake.

## 21. Expose the recommendation endpoint and show the playlist
Goal: Let the results page request and display a playlist.
Description: Add an API route that takes a mood, preferences, and length and returns a playlist, and add a UI section showing the featured song, the reason it matches, and the track list with Spotify and YouTube buttons. Include a loading state and an error state. Tests can use a fake recommendation engine.

## 22. Add "regenerate" and "explore alternatives"
Goal: Let the user get a different playlist without re-analyzing the photo.
Description: Add buttons that call the recommendation endpoint again with the same mood and preferences, excluding tracks already shown, or with a nudged mood. The photo analysis must be reused, not repeated. Add a test that confirms the analysis function is not called again.

## 23. Generate Instagram captions, hashtags, and story text
Goal: Produce copy-ready social content from the photo's mood.
Description: Write a server module that sends the mood, the featured song, and the photo description to an LLM and returns several captions in different tones, a list of relevant hashtags, and short story text, validated against a schema. Add an endpoint and a results page section with a copy-to-clipboard button for each item. Nothing is posted to Instagram automatically.

## 24. Create the object storage module for private photos
Goal: Store and retrieve user photos privately.
Description: Write a module over an S3-compatible service (S3, Cloudflare R2, or MinIO for local development) that uploads an image under a user-specific key, creates short-lived signed URLs for viewing, and deletes objects. No image may be publicly readable. Test it against a local MinIO container or a mocked client.

## 25. Add database tables for saved analyses and playlists
Goal: Persist photos, moods, and playlists for registered users.
Description: Add migrations for `photos` (owner, storage key, palette), `analyses` (mood JSON, correction flag), and `playlists` with `playlist_tracks`, using the project's ORM on PostgreSQL. Include indexes for listing a user's items by newest first and cascade deletion from photo to analysis to playlist. Write repository functions with tests against a test database. Assumes a `users` table exists.

## 26. Save a result to the user's history
Goal: Let a signed-in user save a photo, its mood, and its playlist.
Description: Add a "Save" action, visible only to signed-in users, that stores the photo in private storage and the mood and playlist in the database. Guests never have their photos stored. Show a confirmation, and make saving idempotent so double-clicking does not create duplicates.

## 27. Build the history page and photo deletion
Goal: Show a registered user's saved results and let them delete any of them.
Description: Create a page listing saved photos with thumbnails (through signed URLs), primary mood, and date, with a detail view that reopens the results page. Add a delete button that removes the photo from storage and all related database rows after confirmation. Only the owner may view or delete an item; test those access rules.

## 28. Store and apply saved music preferences
Goal: Remember a registered user's genres, artists, and languages.
Description: Add a `user_preferences` table and a settings page where a signed-in user edits their default genres, favorite artists, and languages. Prefill the preferences form from these defaults. Assumes the users table and the preferences form schema exist.

## 29. Add optional Spotify login to save playlists to the user's account
Goal: Let a user save a generated playlist into their own Spotify account.
Description: Implement the Spotify authorization code flow with the playlist-modify scopes, store the refresh token securely and encrypted, and add a "Save to Spotify" button that creates the playlist and adds the tracks. If Spotify access is not available or fails, show a clear message and fall back to individual track links. Check Spotify's current requirements for apps before starting.

## 30. Add privacy controls and a basic privacy notice
Goal: Make clear what happens to uploaded photos and let users remove their data.
Description: Add a short privacy page explaining that guest photos are not stored and saved photos can be deleted. Add an "Delete my account and all data" action that removes the user, their database rows, and their stored photos. Test that deletion leaves no orphaned records or objects.

## 31. Add error handling, loading states, and accessibility checks
Goal: Make the main flow robust and usable for everyone.
Description: Review the upload, analysis, and playlist flows for loading indicators, error messages, and empty states. Check keyboard navigation, color contrast (especially on photo-derived backgrounds), and alt text, and fix the issues found. Add an automated accessibility check, such as axe, to the test suite for the main pages.

## 32. Add an end-to-end test for the main user journey
Goal: Verify upload → mood → playlist → captions works in a real browser.
Description: Using Playwright, write a test that uploads a fixture photo, waits for the results page, changes the mood, regenerates the playlist, and copies a caption. Run it with fake analysis, music, and caption providers selected through configuration so it needs no external services. Add it to the CI workflow.

## 33. Deploy the app to a hosting platform
Goal: Make the app available at a public URL.
Description: Deploy the Next.js app to Vercel or a similar platform with a managed PostgreSQL database and an object storage bucket. Configure the environment variables, run migrations in the deploy process, and confirm the main flow works in production. Document the steps and any time limits to watch for on long-running requests.
