import { rmSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import esbuild from 'esbuild';

const outdir = path.resolve('.tmp-smoke');
const port = Number(process.env.DEV_API_PORT ?? 8787);

function tsEntries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

const entries = [...tsEntries('api'), ...tsEntries('src/server'), ...tsEntries('src/shared')];

rmSync(outdir, { recursive: true, force: true });

await esbuild.build({ entryPoints: entries, outdir, outbase: '.', format: 'esm', logLevel: 'silent' });

const entryModule = await import(pathToFileURL(path.join(outdir, 'api', '[[...route]].js')).href);
const handler = entryModule.default.fetch;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  const request = new Request(url, { method: req.method, headers, body, duplex: 'half' });
  try {
    const response = await handler(request);
    const resHeaders = Object.fromEntries(response.headers.entries());
    res.writeHead(response.status, resHeaders);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded' }));
    console.error('dev-api handler error:', err);
  }
});

server.listen(port, () => {
  console.log(`dev-api: hono API on http://localhost:${port} (DEMO_MODE=${process.env.DEMO_MODE ?? 'unset'})`);
});
