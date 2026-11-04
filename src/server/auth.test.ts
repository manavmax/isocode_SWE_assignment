import { describe, expect, it } from 'vitest';
import { hashPassword, parseBasicAuth, validManagerActor, verifyPassword } from './auth.js';

describe('parseBasicAuth', () => {
  it('decodes base64 user and password', () => {
    const header = `Basic ${Buffer.from('mgr@example.com:secret', 'utf8').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ username: 'mgr@example.com', password: 'secret' });
  });

  it('returns null for non-basic schemes and malformed payloads', () => {
    expect(parseBasicAuth('Bearer abc')).toBeNull();
    expect(parseBasicAuth('Basic !!!not-base64')).toBeNull();
    expect(parseBasicAuth('Basic aGVsbG8=')).toBeNull();
    expect(parseBasicAuth('')).toBeNull();
  });
});

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

describe('validManagerActor', () => {
  it('accepts only active branch managers', () => {
    expect(validManagerActor({ role: 'branch_manager', active: true })).toBe(true);
    expect(validManagerActor({ role: 'field_officer', active: true })).toBe(false);
    expect(validManagerActor({ role: 'branch_manager', active: false })).toBe(false);
  });
});
