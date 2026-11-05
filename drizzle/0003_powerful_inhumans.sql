CREATE TABLE "login_attempt" (
	"key" text PRIMARY KEY NOT NULL,
	"fail_count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
