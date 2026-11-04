import { handle } from 'hono/vercel';
import { app } from '../src/server/app';

export default handle(app);
