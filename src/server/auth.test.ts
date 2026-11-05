import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './auth.js';

describe('hashPassword and verifyPassword', () => {
  it('hashes with a random salt and verifies the same password', () => {
    const hash = hashPassword('demo-secret');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toBe(hashPassword('demo-secret'));
    expect(verifyPassword(hash, 'demo-secret')).toBe(true);
  });

  it('rejects wrong passwords and malformed stored hashes', () => {
    const hash = hashPassword('demo-secret');
    expect(verifyPassword(hash, 'wrong')).toBe(false);
    expect(verifyPassword('garbage', 'demo-secret')).toBe(false);
  });
});
