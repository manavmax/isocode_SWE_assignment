import type { ReactNode } from 'react';
import { DpdBucket } from '../../shared/types.js';

/** Skeleton placeholder list — skeletons, never spinners (SPEC 15). */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div className="card skeleton" key={i}>
          <div className="skeleton-line w-60" />
          <div className="skeleton-line w-40" />
          <div className="skeleton-line w-30" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="state" data-testid="empty">
      <p className="state-title">{title}</p>
      {body ? <p className="state-body">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title, body, onRetry, retryLabel }: { title: string; body: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div className="state state-error" role="alert" data-testid="error">
      <p className="state-title">{title}</p>
      <p className="state-body">{body}</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}

export function OfflineBanner({ text }: { text: string }) {
  return (
    <div className="offline-banner" role="status" data-testid="offline-banner">
      {text}
    </div>
  );
}

const BUCKET_CLASS: Record<DpdBucket, string> = {
  'not-overdue': 'bucket-0',
  '1-30': 'bucket-1',
  '31-60': 'bucket-2',
  '61-90': 'bucket-3',
  '90+': 'bucket-4'
};

export function bucketClass(bucket: string): string {
  return BUCKET_CLASS[bucket as DpdBucket] ?? 'bucket-0';
}

/** DPD bucket chip: single-hue ramp + text label (SPEC 15). */
export function BucketChip({ bucket, label }: { bucket: string; label: string }) {
  return (
    <span className={`chip ${bucketClass(bucket)}`}>
      <span className="chip-swatch" aria-hidden="true" />
      {label}
    </span>
  );
}
