CREATE TABLE "youtube_link_cache" (
	"title" text NOT NULL,
	"first_artist" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "youtube_link_cache_title_first_artist_pk" PRIMARY KEY("title","first_artist"),
	CONSTRAINT "youtube_link_cache_kind_check" CHECK ("youtube_link_cache"."kind" in ('video', 'search'))
);
