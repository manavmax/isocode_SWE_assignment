import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import contracts from './contracts.json';

/**
 * Layout-contract tests (prompt 16): every screen component must carry its
 * data-section attributes in exactly the contract's order, and must open
 * with the "layout contract" comment naming it. The design audit asserts
 * the same order against the live DOM at runtime; this file pins the
 * source so a reorder fails here first.
 */

const dir = fileURLToPath(new URL('.', import.meta.url));

function sectionsIn(file: string, screen: string): string[] {
  const text = readFileSync(dir + file, 'utf8');
  // data-section="x" on DOM elements, dataSection="x" on ResponsiveTable
  // (prompt 20 item 6: the table-or-cards branch carries the same section)
  return [...text.matchAll(/data-?s[e]ction="([a-z-]+)"/gi)]
    .map((match) => match[1]!)
    .filter((section) => section !== screen); // a whole-screen marker is not a section
}

function hasContractComment(file: string, screen: string): boolean {
  const text = readFileSync(dir + file, 'utf8');
  return text.includes('layout contract') && text.includes(`"${screen}"`);
}

const SCREENS: { contract: keyof typeof contracts; file: string }[] = [
  { contract: 'today', file: 'Today.tsx' },
  { contract: 'detail', file: 'LoanDetail.tsx' },
  { contract: 'sheet', file: '../components/OutcomeSheet.tsx' },
  { contract: 'manager', file: 'ManagerDashboard.tsx' },
  { contract: 'import', file: 'ManagerImport.tsx' },
  { contract: 'activity', file: 'OfficerActivity.tsx' }
];

describe('layout contracts (prompt 16): data-section order per screen', () => {
  for (const { contract, file } of SCREENS) {
    it(`${contract} (${file}) renders its sections in the contract order`, () => {
      const expected = contracts[contract] as string[];
      const actual = sectionsIn(file, contract);
      // The nav lives in App.tsx (shared chrome) — appended, not inline.
      const expectedInline = expected.filter((section) => section !== 'nav');
      expect(actual).toEqual(expectedInline);
    });

    it(`${contract} (${file}) documents the contract at the top of the component`, () => {
      expect(hasContractComment(file, contract)).toBe(true);
    });
  }

  it('the shared nav carries data-section="nav" (last section of every screen)', () => {
    const text = readFileSync(dir + '../App.tsx', 'utf8');
    expect(text.includes('data-section="nav"')).toBe(true);
  });
});
