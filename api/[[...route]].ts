import { handle } from 'hono/vercel';
import { app } from '../src/server/app.js';

export default handle(app);
