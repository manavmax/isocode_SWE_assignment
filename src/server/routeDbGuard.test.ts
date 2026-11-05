import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The single seam that keeps data access in the DAL (SPEC 24, prompt 7):
 * route-composition files (the Vercel entrypoints under api/) and the app
 * itself may never import a database driver or drizzle directly — every query
 * goes through a dal function that takes an actor. Written as a test instead
 * of a lint rule so it runs in CI with the rest of the suite.
 */
const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /(['"])drizzle-orm\1/, label: 'the drizzle-orm driver import' },
  { pattern: /(['"])@neondatabase\/serverless\1/, label: 'the neon driver import' },
  { pattern: /from\s+['"][^'"]*\/db(\.js)?['"]/, label: 'a direct server/db.js import' }
];

function routeFiles(): string[] {
  const apiEntries = readdirSync('api', { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.ts'));
  return [...apiEntries.map((entry) => join('api', entry)), 'src/server/app.ts'];
}

describe('route compositions import data access, never a db driver', () => {
  it('api/ entrypoints and src/server/app.ts hold no driver-level imports', () => {
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${file}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the api/ entrypoints delegate to src/server/app.js', () => {
    for (const file of routeFiles().filter((f) => f.startsWith('api'))) {
      expect(readFileSync(file, 'utf8')).toContain('src/server/app.js');
    }
  });
});
