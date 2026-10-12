# Photo-to-Music Website: Project Plan

A photo-inspired music discovery and social-content website. Users upload a photo, discover its musical mood, get a featured song and a playlist, and receive ready-to-use Instagram content.

---

## 1. Product Decisions (made together)

| # | Question | Decision |
|---|----------|----------|
| 1 | After upload | Detect emotion first, then recommend a song, then generate a playlist. Explain why the song matches the emotion. |
| 2 | Emotions recognized | Basic emotions as the foundation (happy, sad, calm, energetic, romantic), plus nuanced moods when the photo supports them (e.g. sad + nostalgic). |
| 3 | What is analyzed | The entire photo: colors, lighting, scenery, and atmosphere. No reliance on facial expressions. |
| 4 | Music delivery | Both Spotify and YouTube. Users choose which one to use. Spotify playlists they can open in Spotify, and YouTube links to music videos. |
| 5 | Personalization | Mood + music taste (genres, favorite artists, languages) + optional situation (studying, walking at night, relaxing, driving). |
| 6 | Accounts | Optional. Anyone can try the app; registered users can save playlists and preferences. |
| 7 | Photo handling | Saved photo history for registered users: revisit photos, moods, and playlists. |
| 8 | Playlist length | User chooses 5, 10, 20, or 30 songs. |
| 9 | Control after results | Both: correct the detected mood, regenerate recommendations, and explore alternatives. |
| 10 | Results page | Immersive experience: main emotion, secondary moods, short atmosphere explanation, music recommendations, and a visually rich page inspired by the photo's colors. Plus Instagram content (captions, hashtags, etc.). |
| 11 | Social content | Instagram only for the MVP (captions, hashtags, story text). Other platforms later. |

### Core recommendation logic
- **Photo mood** is the primary factor.
- **Music preferences** (genres, favorite artists, languages) refine results.
- **Optional situation** (studying, walking at night, relaxing, etc.) adjusts further.

---

## 2. Key Decisions Made on Your Behalf

### 2.1 Analyze the entire photo with a vision AI model
- **Chosen:** Use a vision-capable AI model to interpret scenery, colors, lighting, and atmosphere, returning a primary emotion, secondary moods, and a short explanation.
- **Why:** Works for landscapes, architecture, objects, and selfies without depending on facial expressions.
- **Alternative:** A traditional image classifier. Potentially cheaper but less flexible for nuanced moods.

### 2.2 Separate mood analysis from song selection
- **Chosen:** First convert the photo into structured mood tags (e.g. melancholic, dreamy, calm). Then use those tags, music preferences, and the optional situation to rank songs.
- **Why:** Easier to explain recommendations, correct moods, and improve matching independently.
- **Alternative:** Ask AI to invent song recommendations directly. Simpler at first but can produce inaccurate song titles or weak matches.

### 2.3 Integrate Spotify and YouTube
- **Chosen:** Use real track metadata and links, with Spotify playlist creation for authorized users where API access permits. Provide YouTube search or video links as an alternative.
- **Why:** Users can listen on services they already use.
- **Alternative:** Build an in-app music player. Creates extra licensing, playback, and infrastructure work.

### 2.4 Generate Instagram content with AI
- **Chosen:** Generate several captions, relevant hashtags, optional story text, and different writing tones based on the photo and detected mood.
- **Why:** Adds a distinct social-sharing benefit beyond ordinary music recommendation.
- **Alternative:** Fixed caption templates. Predictable but less personal.

---

## 3. Architecture and Technology

**Decision:** Next.js full-stack (TypeScript) + PostgreSQL, one codebase.

| Area | Choice | Why |
|------|--------|-----|
| Framework | Next.js (App Router) + TypeScript | One codebase and language for UI and server; server-rendered result pages give proper link previews for sharing |
| Backend logic | Next.js route handlers / server actions | API keys, auth checks, and image processing stay server-side |
| Database | PostgreSQL with Prisma or Drizzle | Stores users, preferences, analysis results, playlists, and history |
| Image analysis | Hosted vision AI API | Avoids training and hosting a custom vision model |
| Music data | Spotify and YouTube integrations | Real songs and playable destinations |
| Image storage | Private S3-compatible object storage (S3 or Cloudflare R2), signed URLs | Supports saved photo history without putting images in public folders |
| Authentication | Auth.js (email/password with secure sessions) | Simple account system for the MVP |
| Hosting | Vercel or similar | Easy deployment for a Next.js app |

**Known trade-offs of this choice:**
- Serverless time limits: a slow vision call plus building a 30-track playlist can time out. Use streaming responses or a background job, and cache each analysis so regeneration never repeats the vision call.
- Framework lock-in to Next.js conventions, and less predictable hosting cost than a fixed server.
- Spotify has restricted parts of its API for new apps (audio features, recommendations). Verify current access before designing the song-ranking step.

**Alternatives considered:** React + Express + PostgreSQL (separate frontend/backend), React + FastAPI (Python), and SvelteKit/Nuxt + Supabase. Next.js was chosen for the fastest route to a polished MVP.

**Why not train our own AI model?** It would require a labeled image dataset, model training, evaluation, and hosting. A hosted vision model lets us focus on building the actual product.

**Why PostgreSQL instead of MongoDB?** Users, preferences, photos, analyses, and playlists have clear relationships. A relational database makes those relationships easier to manage.

**Why a full-stack framework rather than a frontend-only app?** API credentials, authentication checks, image processing, and database access run on the server side of Next.js and never reach the browser.

---

## 4. The Complete User Journey

1. **Upload a photo**: guest or registered user.
2. **Analyze the atmosphere**: main emotion, nuanced moods, explanation, colors.
3. **Adjust preferences**: genres, artists, language, optional situation, mood correction.
4. **Discover music**: featured song + 5, 10, 20, or 30-track playlist.
5. **Get social content**: captions, hashtags, story text, photo-inspired design.
6. **Listen, save, or share**: Spotify, YouTube, or account history.

---

## 5. Decisions That Keep the Project Realistic

- **Guest access:** No account required for analysis and recommendations. Accounts unlock saved history and preferences.
- **Photo privacy:** Save uploaded photos only for registered users who choose to save the result. Provide deletion controls.
- **Regeneration:** Reuse the existing analysis when generating alternatives; don't repeatedly call the vision API unnecessarily.
- **Mood uncertainty:** Present moods as interpretations, not objective facts. Allow users to correct them.
- **Music availability:** Never invent tracks. If an integration cannot retrieve a track or create a playlist, provide an appropriate search link or explain the limitation.
- **No automatic social posting:** Generate copy-ready content rather than requesting Instagram publishing permissions. Direct publishing adds complexity and platform restrictions.
- **No recommendation model training:** Begin with mood tags, metadata, and a ranking algorithm. Improve later using explicit user feedback.

> **Technical note:** Opening a playlist on Spotify is not the same as creating and saving a playlist in a user's Spotify account. The latter may require Spotify authorization and API access. Verify current platform requirements before committing to that exact behavior.

---

## 6. MVP Scope

| Feature | Status |
|---------|--------|
| Photo upload and mood analysis | Core |
| Mood correction and explanation | Core |
| Song recommendation and playlist lengths | Core |
| Spotify and YouTube links | Core |
| AI captions, hashtags, and story text | Core |
| Photo-inspired results page | Core |
| Optional accounts and saved history | Core |
| Saved Spotify playlists | Integration-dependent |
| TikTok and Pinterest support | Later |
| Collaborative playlists and social profiles | Later |

**Guiding principle:** Make the first release a polished, end-to-end experience rather than a large platform with unfinished features. Prove that a photo can lead to a convincing mood interpretation, genuinely relevant songs, and useful social content.
