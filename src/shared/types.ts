import { z } from 'zod';

export const DPD_BUCKETS = ['not-overdue', '1-30', '31-60', '61-90', '90+'] as const;
export const dpdBucketSchema = z.enum(DPD_BUCKETS);
export type DpdBucket = z.infer<typeof dpdBucketSchema>;

export const LOAN_STATUSES = ['overdue', 'cleared', 'queue'] as const;
export const loanStatusSchema = z.enum(LOAN_STATUSES);
export type LoanStatus = z.infer<typeof loanStatusSchema>;

export const USER_ROLES = ['field_officer', 'branch_manager'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const CONTACT_KINDS = ['CALL', 'VISIT', 'MESSAGE', 'BLOCKED'] as const;
export const contactKindSchema = z.enum(CONTACT_KINDS);
export type ContactKind = z.infer<typeof contactKindSchema>;

/**
 * Outcome vocabulary for contact attempts. 'dispute' and 'dialled' are the
 * additions for the event-sync work (assumption A50): 'dispute' records the
 * borrower disputing the debt (SPEC 12 disputed-promise edge case), 'dialled'
 * a connected attempt that produced no terminal answer.
 */
export const CONTACT_OUTCOMES = ['paid', 'promise_to_pay', 'not_reachable', 'dispute', 'dialled', 'refused', 'wrong_number'] as const;
export const contactOutcomeSchema = z.enum(CONTACT_OUTCOMES);
export type ContactOutcome = z.infer<typeof contactOutcomeSchema>;

export const GPS_STATUSES = ['ok', 'low_accuracy', 'denied', 'unavailable', 'timeout', 'not_requested'] as const;
export const gpsStatusSchema = z.enum(GPS_STATUSES);
export type GpsStatus = z.infer<typeof gpsStatusSchema>;

export const TIME_CONFIDENCES = ['high', 'low', 'suspect'] as const;
export const timeConfidenceSchema = z.enum(TIME_CONFIDENCES);
export type TimeConfidence = z.infer<typeof timeConfidenceSchema>;

export const COMPLIANCE_STATUSES = ['COMPLIANT', 'VIOLATION_DETECTED', 'FLAGGED'] as const;
export const complianceStatusSchema = z.enum(COMPLIANCE_STATUSES);
export type ComplianceStatus = z.infer<typeof complianceStatusSchema>;

export const PROMISE_STATUSES = ['open', 'kept', 'broken', 'broken_part', 'superseded', 'disputed'] as const;
export const promiseStatusSchema = z.enum(PROMISE_STATUSES);
export type PromiseStatus = z.infer<typeof promiseStatusSchema>;

export const MESSAGE_LANGUAGES = ['hi', 'en'] as const;
export const messageLanguageSchema = z.enum(MESSAGE_LANGUAGES);
export type MessageLanguage = z.infer<typeof messageLanguageSchema>;

export const MESSAGE_STATUSES = ['queued', 'held', 'sent', 'failed'] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const IMPORT_BATCH_STATUSES = ['imported', 'replaced', 'rejected'] as const;
export const importBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

export const ROW_ERROR_SEVERITIES = ['error', 'warning'] as const;
export const rowErrorSeveritySchema = z.enum(ROW_ERROR_SEVERITIES);
export type RowErrorSeverity = z.infer<typeof rowErrorSeveritySchema>;

export const PAYMENT_SOURCES = ['mock', 'lms_delta'] as const;
export const paymentSourceSchema = z.enum(PAYMENT_SOURCES);
export type PaymentSource = z.infer<typeof paymentSourceSchema>;

export const ruleSetIdSchema = z.enum(['RBC2025_para100', 'RECOVERY2026_100Y']);
export type RuleSetId = z.infer<typeof ruleSetIdSchema>;

export const moneyPaiseSchema = z.number().int().nonnegative();
export type MoneyPaise = z.infer<typeof moneyPaiseSchema>;
