import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface ActorRole {
  role: 'field_officer' | 'branch_manager';
  active: boolean;
}

export function parseBasicAuth(header: string | null | undefined): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1 || !decoded.slice(separator + 1)) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  try {
    const hash = scryptSync(password, Buffer.from(parts[4]!, 'hex'), 32);
    const expected = Buffer.from(parts[5]!, 'hex');
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

export function validManagerActor(actor: ActorRole | null | undefined): boolean {
  return Boolean(actor && actor.active && actor.role === 'branch_manager');
}
