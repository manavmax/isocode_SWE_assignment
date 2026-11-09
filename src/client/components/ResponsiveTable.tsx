import { useSyncExternalStore, type ReactNode } from 'react';

/**
 * Phone-width tables (prompt 20 item 6): below 640px a <table> is NEVER
 * rendered — each row becomes a stacked card (name 16/600, the key number
 * large and right-aligned, 2-3 small chips for the remaining fields, an
 * optional full-width action). Desktop (>= 640px) keeps the real table.
 * Both branches render from the same row data, so nothing about the data
 * or the API contract changes.
 */

const PHONE_QUERY = '(max-width: 639.9px)';

function subscribePhone(callback: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false // server snapshot: desktop markup is the default
  );
}

export type PhoneCard = {
  key: string;
  /** Borrower or officer name — 16/600 on the card. */
  name: ReactNode;
  /** The key number — large and right-aligned. */
  keyNum: ReactNode;
  /** 32/600 key number variant (prompt 21 officer roll %). */
  keyLarge?: boolean;
  /** Optional thin dot bar under the top row (prompt 21). */
  gauge?: ReactNode;
  /** 2-3 small chips for the remaining fields. */
  chips: ReactNode[];
  /** Optional full-width action row (button / link). */
  action?: ReactNode;
  /** Greyed rows (SPEC 13, n < 30) keep the low-lane opacity. */
  greyed?: boolean;
};

export function ResponsiveTable({ headers, rows, cards, dataSection }: {
  headers: ReactNode;
  rows: ReactNode;
  cards: PhoneCard[];
  dataSection?: string;
}) {
  const isPhone = useIsPhone();
  const section = dataSection ? { 'data-section': dataSection } : {};
  if (isPhone) {
    return (
      <div className="phone-cards" {...section}>
        {cards.map((card) => (
          <div key={card.key} className={`card phone-card${card.greyed ? ' lane-low' : ''}`}>
            <div className="phone-card-top">
              <span className="phone-card-name">{card.name}</span>
              <span className={`phone-card-key num${card.keyLarge ? ' phone-card-key-lg' : ''}`}>{card.keyNum}</span>
            </div>
            {card.gauge ? <div className="phone-card-gauge">{card.gauge}</div> : null}
            <div className="phone-card-chips">
              {card.chips.map((chip, index) => (
                <span key={index} className="phone-chip">{chip}</span>
              ))}
            </div>
            {card.action ? <div className="phone-card-action">{card.action}</div> : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <table className="manager-table" {...section}>
      {headers}
      {rows}
    </table>
  );
}
