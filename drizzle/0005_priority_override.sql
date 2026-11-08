CREATE TABLE "loan_priority_override" (
	"loan_id" text PRIMARY KEY REFERENCES "loan"("loan_id") ON DELETE CASCADE,
	"officer_id" uuid NOT NULL REFERENCES "officer"("id"),
	"pinned_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"pinned_at" timestamp with time zone NOT NULL DEFAULT now()
);
