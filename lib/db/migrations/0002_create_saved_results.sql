CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"primary_emotion" text NOT NULL,
	"secondary_moods" jsonb NOT NULL,
	"explanation" text NOT NULL,
	"confidence" double precision NOT NULL,
	"mood_corrected" boolean DEFAULT false NOT NULL,
	"palette" jsonb NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_photo_id_key" UNIQUE("photo_id"),
	CONSTRAINT "analyses_primary_emotion_check" CHECK ("analyses"."primary_emotion" in ('happy', 'sad', 'calm', 'energetic', 'romantic')),
	CONSTRAINT "analyses_confidence_check" CHECK ("analyses"."confidence" >= 0 and "analyses"."confidence" <= 1),
	CONSTRAINT "analyses_secondary_moods_check" CHECK (jsonb_typeof("analyses"."secondary_moods") = 'array' and jsonb_array_length("analyses"."secondary_moods") <= 3)
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"save_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_user_id_save_id_key" UNIQUE("user_id","save_id"),
	CONSTRAINT "photos_storage_key_key" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"spotify_id" text NOT NULL,
	"spotify_url" text NOT NULL,
	"title" text NOT NULL,
	"artists" jsonb NOT NULL,
	"album" text,
	"duration_ms" integer NOT NULL,
	"cover_image_url" text,
	"youtube_kind" text NOT NULL,
	"youtube_url" text NOT NULL,
	"match_reason" text NOT NULL,
	CONSTRAINT "playlist_tracks_playlist_id_position_key" UNIQUE("playlist_id","position"),
	CONSTRAINT "playlist_tracks_playlist_id_spotify_id_key" UNIQUE("playlist_id","spotify_id"),
	CONSTRAINT "playlist_tracks_youtube_kind_check" CHECK ("playlist_tracks"."youtube_kind" in ('video', 'search')),
	CONSTRAINT "playlist_tracks_position_check" CHECK ("playlist_tracks"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"requested_length" integer NOT NULL,
	"featured_spotify_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlists_requested_length_check" CHECK ("playlists"."requested_length" in (5, 10, 20, 30))
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photos_user_id_created_at_id_idx" ON "photos" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playlists_photo_id_idx" ON "playlists" USING btree ("photo_id");