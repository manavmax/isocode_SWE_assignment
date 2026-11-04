CREATE TYPE "public"."compliance_status" AS ENUM('COMPLIANT', 'VIOLATION_DETECTED', 'FLAGGED');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('CALL', 'VISIT', 'MESSAGE', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."gps_status" AS ENUM('ok', 'low_accuracy', 'denied', 'unavailable', 'timeout', 'not_requested');--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('imported', 'replaced', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('overdue', 'cleared', 'queue');--> statement-breakpoint
CREATE TYPE "public"."message_language" AS ENUM('hi', 'en');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'held', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('mock', 'lms_delta');--> statement-breakpoint
CREATE TYPE "public"."promise_status" AS ENUM('open', 'kept', 'broken', 'broken_part', 'superseded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."row_error_severity" AS ENUM('error', 'warning');--> statement-breakpoint
CREATE TYPE "public"."time_confidence" AS ENUM('high', 'low', 'suspect');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('field_officer', 'branch_manager');--> statement-breakpoint
CREATE TABLE "assignment_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"run_date" date NOT NULL,
	"from_officer" uuid,
	"to_officer" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "branch_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "contact_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"officer_id" uuid,
	"kind" "contact_kind" NOT NULL,
	"outcome" text,
	"attempted_at_device" timestamp with time zone NOT NULL,
	"device_tz_offset_minutes" integer NOT NULL,
	"skew_estimate_ms" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at_ist" timestamp with time zone NOT NULL,
	"within_window" boolean NOT NULL,
	"time_confidence" time_confidence DEFAULT 'low' NOT NULL,
	"rule_set" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"accuracy_m" integer,
	"gps_status" "gps_status",
	"note" text,
	"corrects_event_id" uuid,
	"compliance_status" "compliance_status"
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"as_of" date NOT NULL,
	"file_sha256" text NOT NULL,
	"filename" text NOT NULL,
	"status" "import_batch_status" NOT NULL,
	"row_counts_json" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_import_batch_asof_sha" UNIQUE("as_of","file_sha256")
);
--> statement-breakpoint
CREATE TABLE "import_row_error" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"loan_id" text,
	"source_column" text NOT NULL,
	"code" text NOT NULL,
	"severity" "row_error_severity" NOT NULL,
	"raw_value" text,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_snapshot" (
	"as_of" date NOT NULL,
	"loan_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"officer_id" uuid,
	"dpd" integer NOT NULL,
	"bucket" text NOT NULL,
	"outstanding" bigint NOT NULL,
	CONSTRAINT "loan_snapshot_as_of_loan_id_pk" PRIMARY KEY("as_of","loan_id")
);
--> statement-breakpoint
CREATE TABLE "loan" (
	"loan_id" text PRIMARY KEY NOT NULL,
	"borrower_name" text NOT NULL,
	"business_name" text,
	"mobile" text,
	"alt_mobile" text,
	"address" text,
	"pincode" text,
	"locality" text,
	"branch_id" uuid NOT NULL,
	"product" text,
	"outstanding" bigint NOT NULL,
	"overdue_amount" bigint NOT NULL,
	"emi_amount" bigint,
	"dpd" integer NOT NULL,
	"bucket" text NOT NULL,
	"assigned_officer_id" uuid,
	"home_officer_id" uuid,
	"entered_overdue_on" date,
	"status" "loan_status" DEFAULT 'overdue' NOT NULL,
	"bounce_count_12m" integer DEFAULT 0 NOT NULL,
	"vintage_months" integer,
	"is_demo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"promise_id" uuid,
	"kind" text NOT NULL,
	"template_id" text NOT NULL,
	"language" "message_language" NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"provider_ref" text,
	CONSTRAINT "uq_message_outbox_promise_kind" UNIQUE("promise_id","kind")
);
--> statement-breakpoint
CREATE TABLE "officer_absence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"officer_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"cover_officer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "officer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"capacity_points" integer DEFAULT 30 NOT NULL,
	"buddy_officer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"source" "payment_source" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"officer_id" uuid,
	"source_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promised_amount" bigint NOT NULL,
	"promised_date" date NOT NULL,
	"grace_days" integer DEFAULT 1 NOT NULL,
	"status" "promise_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"paid_amount" bigint,
	"superseded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "roll_cohort" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"t0" date NOT NULL,
	"t1" date NOT NULL,
	"branch_id" uuid NOT NULL,
	"officer_id" uuid,
	"cohort_n" integer NOT NULL,
	"cured_n" integer NOT NULL,
	"stayed_n" integer NOT NULL,
	"rolled_n" integer NOT NULL,
	"cohort_amt" bigint NOT NULL,
	"rolled_amt" bigint NOT NULL,
	CONSTRAINT "uq_roll_cohort_window_scope" UNIQUE NULLS NOT DISTINCT("t0","t1","branch_id","officer_id")
);
--> statement-breakpoint
CREATE TABLE "score_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" text NOT NULL,
	"as_of" date NOT NULL,
	"p_roll" double precision NOT NULL,
	"score" integer NOT NULL,
	"rank" integer NOT NULL,
	"reasons_json" jsonb NOT NULL,
	"features_json" jsonb NOT NULL,
	"model_version" text NOT NULL,
	CONSTRAINT "uq_score_log_loan_asof" UNIQUE("loan_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "territory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"pincode" text NOT NULL,
	"locality" text,
	"officer_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "uq_territory_scope" UNIQUE NULLS NOT DISTINCT("branch_id","pincode","locality","officer_id")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"branch_id" uuid NOT NULL,
	"officer_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "app_user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "assignment_log" ADD CONSTRAINT "assignment_log_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_log" ADD CONSTRAINT "assignment_log_from_officer_officer_id_fk" FOREIGN KEY ("from_officer") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_log" ADD CONSTRAINT "assignment_log_to_officer_officer_id_fk" FOREIGN KEY ("to_officer") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_corrects_event_id_contact_event_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."contact_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row_error" ADD CONSTRAINT "import_row_error_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_snapshot" ADD CONSTRAINT "loan_snapshot_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_snapshot" ADD CONSTRAINT "loan_snapshot_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_snapshot" ADD CONSTRAINT "loan_snapshot_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_assigned_officer_id_officer_id_fk" FOREIGN KEY ("assigned_officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_home_officer_id_officer_id_fk" FOREIGN KEY ("home_officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_promise_id_promise_id_fk" FOREIGN KEY ("promise_id") REFERENCES "public"."promise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer_absence" ADD CONSTRAINT "officer_absence_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer_absence" ADD CONSTRAINT "officer_absence_cover_officer_id_officer_id_fk" FOREIGN KEY ("cover_officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "officer" ADD CONSTRAINT "officer_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise" ADD CONSTRAINT "promise_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise" ADD CONSTRAINT "promise_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise" ADD CONSTRAINT "promise_source_event_id_contact_event_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."contact_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_cohort" ADD CONSTRAINT "roll_cohort_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_cohort" ADD CONSTRAINT "roll_cohort_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_log" ADD CONSTRAINT "score_log_loan_id_loan_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loan"("loan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory" ADD CONSTRAINT "territory_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory" ADD CONSTRAINT "territory_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_officer_id_officer_id_fk" FOREIGN KEY ("officer_id") REFERENCES "public"."officer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assignment_log_loan_date" ON "assignment_log" USING btree ("loan_id","run_date");--> statement-breakpoint
CREATE INDEX "idx_contact_event_loan_attempt" ON "contact_event" USING btree ("loan_id","attempted_at_ist");--> statement-breakpoint
CREATE INDEX "idx_contact_event_kind_window" ON "contact_event" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_import_row_error_batch" ON "import_row_error" USING btree ("batch_id","row_no");--> statement-breakpoint
CREATE INDEX "idx_loan_snapshot_asof_branch" ON "loan_snapshot" USING btree ("as_of","branch_id");--> statement-breakpoint
CREATE INDEX "idx_loan_officer_status" ON "loan" USING btree ("assigned_officer_id","status");--> statement-breakpoint
CREATE INDEX "idx_loan_branch_bucket" ON "loan" USING btree ("branch_id","dpd");--> statement-breakpoint
CREATE INDEX "idx_message_outbox_loan" ON "message_outbox" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "idx_officer_absence_window" ON "officer_absence" USING btree ("officer_id","from_date","to_date");--> statement-breakpoint
CREATE INDEX "idx_officer_branch" ON "officer" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_payment_loan_posted" ON "payment" USING btree ("loan_id","posted_at");--> statement-breakpoint
CREATE INDEX "idx_promise_loan_status" ON "promise" USING btree ("loan_id","status");--> statement-breakpoint
CREATE INDEX "idx_promise_due" ON "promise" USING btree ("promised_date");--> statement-breakpoint
CREATE INDEX "idx_territory_lookup" ON "territory" USING btree ("branch_id","pincode");--> statement-breakpoint
CREATE INDEX "idx_app_user_branch" ON "app_user" USING btree ("branch_id","role");