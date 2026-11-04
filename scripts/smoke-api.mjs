import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const outdir = path.resolve('.tmp-smoke');
const entries = ['api/[[...route]].ts', 'src/server/app.ts', 'src/server/db.ts'];

rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: entries,
  outdir,
  outbase: '.',
  format: 'esm',
  logLevel: 'silent'
});

delete process.env.DATABASE_URL;

const entryUrl = pathToFileURL(path.join(outdir, 'api', '[[...route]].js')).href;
const entryModule = await import(entryUrl);
if (typeof entryModule.default !== 'function') {
  throw new Error('smoke: catch-all entry did not export a callable handler');
}

const appModule = await import(pathToFileURL(path.join(outdir, 'src', 'server', 'app.js')).href);
const response = await appModule.app.request('/api/health');
const body = await response.json();

assert(response.status === 503, `expected 503, got ${response.status}`);
assert(body.status === 'degraded', `expected status degraded, got ${body.status}`);
assert(body.db === 'error', `expected db error, got ${body.db}`);
assert(typeof body.time === 'string' && body.time.length > 0, 'expected ISO time string');

console.log('smoke-api: plain-Node ESM load + degraded health OK');

function assert(condition, message) {
  if (!condition) {
    console.error(`smoke-api FAILED: ${message}`);
    rmSync(outdir, { recursive: true, force: true });
    process.exit(1);
  }
}
