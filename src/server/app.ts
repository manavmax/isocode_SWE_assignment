import { Hono } from 'hono';

export const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    time: new Date().toISOString()
  })
);
