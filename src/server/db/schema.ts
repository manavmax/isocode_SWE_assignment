import {
  bigint,
  boolean,
  doublePrecision,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  COMPLIANCE_STATUSES,
  CONTACT_KINDS,
  GPS_STATUSES,
  IMPORT_BATCH_STATUSES,
  LOAN_STATUSES,
  MESSAGE_LANGUAGES,
  MESSAGE_STATUSES,
  PAYMENT_SOURCES,
  PROMISE_STATUSES,
  ROW_ERROR_SEVERITIES,
  TIME_CONFIDENCES,
  USER_ROLES
} from '../../shared/types.js';

export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const loanStatusEnum = pgEnum('loan_status', LOAN_STATUSES);
export const contactKindEnum = pgEnum('contact_kind', CONTACT_KINDS);
export const gpsStatusEnum = pgEnum('gps_status', GPS_STATUSES);
export const timeConfidenceEnum = pgEnum('time_confidence', TIME_CONFIDENCES);
export const complianceStatusEnum = pgEnum('compliance_status', COMPLIANCE_STATUSES);
export const promiseStatusEnum = pgEnum('promise_status', PROMISE_STATUSES);
export const messageLanguageEnum = pgEnum('message_language', MESSAGE_LANGUAGES);
export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES);
export const importBatchStatusEnum = pgEnum('import_batch_status', IMPORT_BATCH_STATUSES);
export const rowErrorSeverityEnum = pgEnum('row_error_severity', ROW_ERROR_SEVERITIES);
export const paymentSourceEnum = pgEnum('payment_source', PAYMENT_SOURCES);

export const branches = pgTable('branch', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull()
});

export const officers = pgTable(
  'officer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    capacityPoints: integer('capacity_points').notNull().default(30),
    buddyOfficerId: uuid('buddy_officer_id')
  },
  (t) => [index('idx_officer_branch').on(t.branchId)]
);

export const users = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    officerId: uuid('officer_id')
      .references(() => officers.id),
    active: boolean('active').notNull().default(true),
    // Demo logins (SPEC 1 demo-account chips) are seeded from DEMO_MODE=true
    // and can only sign in while it is set: A31.
    isDemo: boolean('is_demo').notNull().default(false)
  },
  (t) => [index('idx_app_user_branch').on(t.branchId, t.role)]
);

/** Server-side auth session (ADR-0005): the cookie carries the raw token; the
 * DB stores only its sha256. One session row per login; 7-day expiry (A30). */
export const sessions = pgTable('session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

/** Login-throttle state (A30): one row per username + client-IP key, shared
 * across serverless instances. windowStart opens the current window at the
 * first recorded failure; a row older than the window rolls into a fresh
 * one on the next failure, so rows stay small without a sweeper. */
export const loginAttempts = pgTable('login_attempt', {
  key: text('key').primaryKey(),
  failCount: integer('fail_count').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull()
});

export const officerAbsences = pgTable(
  'officer_absence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    officerId: uuid('officer_id')
      .notNull()
      .references(() => officers.id),
    fromDate: date('from_date', { mode: 'string' }).notNull(),
    toDate: date('to_date', { mode: 'string' }).notNull(),
    coverOfficerId: uuid('cover_officer_id')
      .references(() => officers.id)
  },
  (t) => [index('idx_officer_absence_window').on(t.officerId, t.fromDate, t.toDate)]
);

export const territory = pgTable(
  'territory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    pincode: text('pincode').notNull(),
    locality: text('locality'),
    officerId: uuid('officer_id')
      .notNull()
      .references(() => officers.id),
    rank: integer('rank').notNull()
  },
  (t) => [
    unique('uq_territory_scope').on(t.branchId, t.pincode, t.locality, t.officerId).nullsNotDistinct(),
    index('idx_territory_lookup').on(t.branchId, t.pincode)
  ]
);

export const loans = pgTable(
  'loan',
  {
    loanId: text('loan_id').primaryKey(),
    borrowerName: text('borrower_name').notNull(),
    businessName: text('business_name'),
    mobile: text('mobile'),
    altMobile: text('alt_mobile'),
    address: text('address'),
    pincode: text('pincode'),
    locality: text('locality'),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    product: text('product'),
    outstanding: bigint('outstanding', { mode: 'number' }).notNull(),
    overdueAmount: bigint('overdue_amount', { mode: 'number' }).notNull(),
    emiAmount: bigint('emi_amount', { mode: 'number' }),
    dpd: integer('dpd').notNull(),
    bucket: text('bucket').notNull(),
    assignedOfficerId: uuid('assigned_officer_id')
      .references(() => officers.id),
    homeOfficerId: uuid('home_officer_id')
      .references(() => officers.id),
    enteredOverdueOn: date('entered_overdue_on', { mode: 'string' }),
    status: loanStatusEnum('status').notNull().default('overdue'),
    bounceCount12m: integer('bounce_count_12m').notNull().default(0),
    vintageMonths: integer('vintage_months'),
    isDemo: boolean('is_demo').notNull().default(true)
  },
  (t) => [
    index('idx_loan_officer_status').on(t.assignedOfficerId, t.status),
    index('idx_loan_branch_bucket').on(t.branchId, t.dpd)
  ]
);

export const loanSnapshots = pgTable(
  'loan_snapshot',
  {
    asOf: date('as_of', { mode: 'string' }).notNull(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    officerId: uuid('officer_id')
      .references(() => officers.id),
    dpd: integer('dpd').notNull(),
    bucket: text('bucket').notNull(),
    outstanding: bigint('outstanding', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.asOf, t.loanId] }),
    index('idx_loan_snapshot_asof_branch').on(t.asOf, t.branchId)
  ]
);

export const importBatches = pgTable(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    fileSha256: text('file_sha256').notNull(),
    filename: text('filename').notNull(),
    status: importBatchStatusEnum('status').notNull(),
    rowCountJson: jsonb('row_counts_json'),
    createdBy: uuid('created_by')
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (t) => [unique('uq_import_batch_asof_sha').on(t.asOf, t.fileSha256)]
);

export const importRowErrors = pgTable(
  'import_row_error',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id),
    rowNo: integer('row_no').notNull(),
    loanId: text('loan_id'),
    sourceColumn: text('source_column').notNull(),
    code: text('code').notNull(),
    severity: rowErrorSeverityEnum('severity').notNull(),
    rawValue: text('raw_value'),
    message: text('message').notNull()
  },
  (t) => [index('idx_import_row_error_batch').on(t.batchId, t.rowNo)]
);

export const assignmentLog = pgTable(
  'assignment_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    runDate: date('run_date', { mode: 'string' }).notNull(),
    fromOfficer: uuid('from_officer')
      .references(() => officers.id),
    toOfficer: uuid('to_officer')
      .references(() => officers.id),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()
  },
  (t) => [index('idx_assignment_log_loan_date').on(t.loanId, t.runDate)]
);

export const contactEvents = pgTable(
  'contact_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    officerId: uuid('officer_id')
      .references(() => officers.id),
    kind: contactKindEnum('kind').notNull(),
    outcome: text('outcome'),
    attemptedAtDevice: timestamp('attempted_at_device', { withTimezone: true, mode: 'date' }).notNull(),
    deviceTzOffsetMinutes: integer('device_tz_offset_minutes').notNull(),
    skewEstimateMs: integer('skew_estimate_ms'),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    attemptedAtIst: timestamp('attempted_at_ist', { withTimezone: true, mode: 'date' }).notNull(),
    withinWindow: boolean('within_window').notNull(),
    timeConfidence: timeConfidenceEnum('time_confidence').notNull().default('low'),
    ruleSet: text('rule_set').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    accuracyM: integer('accuracy_m'),
    gpsStatus: gpsStatusEnum('gps_status'),
    note: text('note'),
    correctsEventId: uuid('corrects_event_id').references((): AnyPgColumn => contactEvents.id),
    complianceStatus: complianceStatusEnum('compliance_status')
  },
  (t) => [
    index('idx_contact_event_loan_attempt').on(t.loanId, t.attemptedAtIst),
    index('idx_contact_event_kind_window').on(t.kind)
  ]
);

export const promises = pgTable(
  'promise',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    officerId: uuid('officer_id')
      .references(() => officers.id),
    sourceEventId: uuid('source_event_id').references((): AnyPgColumn => contactEvents.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    promisedAmount: bigint('promised_amount', { mode: 'number' }).notNull(),
    promisedDate: date('promised_date', { mode: 'string' }).notNull(),
    graceDays: integer('grace_days').notNull().default(1),
    status: promiseStatusEnum('status').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    paidAmount: bigint('paid_amount', { mode: 'number' }),
    supersededBy: uuid('superseded_by')
  },
  (t) => [index('idx_promise_loan_status').on(t.loanId, t.status), index('idx_promise_due').on(t.promisedDate)]
);

export const payments = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }).notNull(),
    source: paymentSourceEnum('source').notNull()
  },
  (t) => [index('idx_payment_loan_posted').on(t.loanId, t.postedAt)]
);

export const messageOutbox = pgTable(
  'message_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    promiseId: uuid('promise_id')
      .references(() => promises.id),
    kind: text('kind').notNull(),
    templateId: text('template_id').notNull(),
    language: messageLanguageEnum('language').notNull(),
    status: messageStatusEnum('status').notNull().default('queued'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }),
    providerRef: text('provider_ref')
  },
  (t) => [
    unique('uq_message_outbox_promise_kind').on(t.promiseId, t.kind),
    index('idx_message_outbox_loan').on(t.loanId)
  ]
);

export const scoreLog = pgTable(
  'score_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: text('loan_id')
      .notNull()
      .references(() => loans.loanId),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    pRoll: doublePrecision('p_roll').notNull(),
    score: integer('score').notNull(),
    rank: integer('rank').notNull(),
    rupeesAtRisk: bigint('rupees_at_risk', { mode: 'number' }).notNull().default(0),
    reasonsJson: jsonb('reasons_json').notNull(),
    featuresJson: jsonb('features_json').notNull(),
    modelVersion: text('model_version').notNull()
  },
  (t) => [unique('uq_score_log_loan_asof').on(t.loanId, t.asOf)]
);

export const rollCohorts = pgTable(
  'roll_cohort',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    t0: date('t0', { mode: 'string' }).notNull(),
    t1: date('t1', { mode: 'string' }).notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    officerId: uuid('officer_id')
      .references(() => officers.id),
    cohortN: integer('cohort_n').notNull(),
    curedN: integer('cured_n').notNull(),
    stayedN: integer('stayed_n').notNull(),
    rolledN: integer('rolled_n').notNull(),
    cohortAmt: bigint('cohort_amt', { mode: 'number' }).notNull(),
    rolledAmt: bigint('rolled_amt', { mode: 'number' }).notNull()
  },
  (t) => [unique('uq_roll_cohort_window_scope').on(t.t0, t.t1, t.branchId, t.officerId).nullsNotDistinct()]
);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  subject: text('subject'),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  detail: jsonb('detail')
});
