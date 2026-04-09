import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveApiAbsolutePath } from './api';

describe('resolveApiAbsolutePath', () => {
  const originalBase = import.meta.env.VITE_API_BASE;

  beforeEach(() => {
    vi.stubGlobal('location', { ...window.location, origin: 'https://app.example.com' });
  });

  afterEach(() => {
    (import.meta.env as any).VITE_API_BASE = originalBase;
    vi.unstubAllGlobals();
  });

  it('returns absolute https URL when VITE_API_BASE is an origin-prefixed API base', () => {
    (import.meta.env as any).VITE_API_BASE = 'https://api.example.com/api/v1';
    expect(resolveApiAbsolutePath('/api/v1/auth/course?x=1')).toBe(
      'https://api.example.com/api/v1/auth/course?x=1',
    );
  });

  it('prefixes same-site path when VITE_API_BASE is relative', () => {
    (import.meta.env as any).VITE_API_BASE = '/api/v1';
    expect(resolveApiAbsolutePath('/api/v1/auth/google')).toBe(
      'https://app.example.com/api/v1/auth/google',
    );
  });

  it('passes through already-absolute URLs', () => {
    (import.meta.env as any).VITE_API_BASE = '/api/v1';
    expect(resolveApiAbsolutePath('https://other.test/start')).toBe('https://other.test/start');
  });
});
