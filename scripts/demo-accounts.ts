/**
 * demo:accounts — idempotent creation of the demo login accounts
 * (docs/deployment.md). Local-only/maintenance script: requires DEMO_MODE=true
 * in the environment, prints the usernames it ensured, and never prints the
 * PIN (it is a documented demo credential, see the docs, not a secret).
 * Demo accounts can only log in from a deployment running DEMO_MODE=true (A31).
 */
import { getDb } from '../src/server/db.js';
import { demoModeEnabled, ensureDemoAccounts } from '../src/server/demo.js';

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

failUnless(demoModeEnabled(), 'refusing to run: DEMO_MODE is not true; demo accounts may only be created for a DEMO_MODE deployment');

const db = getDb();
const summary = await ensureDemoAccounts(db);
console.log(`demo:accounts ensured ${summary.usernames.length} demo user(s) on branch ${summary.branchId}`);
console.log(`demo:accounts users: ${summary.usernames.join(', ')}`);
console.log('demo:accounts PIN is a documented demo credential — see docs/deployment.md (never a real secret)');
console.log('demo:accounts demo logins work only while the deployment runs with DEMO_MODE=true');
