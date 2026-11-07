import { rmSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const outdir = path.resolve('.tmp-smoke');

function tsEntries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

const entries = [...tsEntries('api'), ...tsEntries('src/server'), ...tsEntries('src/shared')];

rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: entries,
  outdir,
  outbase: '.',
  format: 'esm',
  logLevel: 'silent'
});

delete process.env.DATABASE_URL;

try {
  const entryModule = await import(pathToFileURL(path.join(outdir, 'api', 'index.js')).href);

  failNow(typeof entryModule.default === 'function', 'default export is a bare function; Vercel ignores returns there and hangs. Use the documented { fetch } object (or named method exports)');
  failNow(entryModule.default === null || typeof entryModule.default !== 'object', 'default export must be the documented { fetch } object');
  failNow(typeof entryModule.default.fetch !== 'function', 'default export must expose a callable fetch handler');

  const handler = entryModule.default.fetch;
  const response = await withTimeout(handler(new Request('http://localhost/api/health')), 5000);
  const body = await response.json();

  failNow(response.status !== 503, `expected 503, got ${response.status}`);
  failNow(body?.status !== 'degraded', `expected status degraded, got ${JSON.stringify(body)}`);
  failNow(body?.db !== 'error', `expected db error, got ${body.db}`);
  failNow(typeof body?.time !== 'string' || body.time.length === 0, 'expected ISO time string');

  console.log('smoke-api: plain-Node ESM load + { fetch } function shape + degraded health OK');
} catch (err) {
  failNow(true, err?.message);
}

function failNow(failed, message) {
  if (!failed) return;
  console.error(`smoke-api FAILED: ${message}`);
  rmSync(outdir, { recursive: true, force: true });
  process.exit(1);
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`/api/health did not respond within ${ms} ms (hang)`)), ms);
  });
  timer.unref();
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
