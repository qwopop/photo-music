CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"mood" jsonb NOT NULL,
	"mood_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_photo_id_unique" UNIQUE("photo_id")
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"palette" jsonb NOT NULL,
	"save_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "photos_user_id_save_id_key" UNIQUE("user_id","save_id")
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"playlist_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"spotify_id" text NOT NULL,
	"track" jsonb NOT NULL,
	CONSTRAINT "playlist_tracks_playlist_id_position_pk" PRIMARY KEY("playlist_id","position"),
	CONSTRAINT "playlist_tracks_playlist_id_spotify_id_key" UNIQUE("playlist_id","spotify_id")
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"requested_length" integer NOT NULL,
	"featured_spotify_id" text NOT NULL,
	"preferences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlists_requested_length_check" CHECK ("playlists"."requested_length" in (5, 10, 20, 30))
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_photo_id_idx" ON "analyses" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "photos_user_id_created_at_idx" ON "photos" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playlists_analysis_id_idx" ON "playlists" USING btree ("analysis_id");