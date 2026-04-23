'use strict';

const { getTrustedClientIp, isPrivateOrInternalNetwork } = require('../src/utils/trustedClientIp') as {
  getTrustedClientIp: (req: Record<string, unknown>) => string;
  isPrivateOrInternalNetwork: (ip: string) => boolean;
};

function makeReq({ headers = {}, socketAddress = '203.0.113.9', ip }: {
  headers?: Record<string, string | string[]>;
  socketAddress?: string;
  ip?: string;
} = {}) {
  return {
    headers,
    ...(ip !== undefined ? { ip } : {}),
    socket: { remoteAddress: socketAddress },
  };
}

describe('trustedClientIp', () => {
  const prevTrust = process.env.TRUST_NGINX_CLIENT_IP_HEADERS;

  afterEach(() => {
    if (prevTrust === undefined) delete process.env.TRUST_NGINX_CLIENT_IP_HEADERS;
    else process.env.TRUST_NGINX_CLIENT_IP_HEADERS = prevTrust;
  });

  it('prefers X-Real-IP over forged X-Forwarded-For', () => {
    delete process.env.TRUST_NGINX_CLIENT_IP_HEADERS;
    const req = makeReq({
      headers: {
        'x-real-ip': '198.51.100.2',
        'x-forwarded-for': '10.0.0.1, 198.51.100.2',
      },
      socketAddress: '172.18.0.2',
    });
    expect(getTrustedClientIp(req)).toBe('198.51.100.2');
  });

  it('treats 10.x as private (grader / internal)', () => {
    expect(isPrivateOrInternalNetwork('10.128.0.2')).toBe(true);
    expect(isPrivateOrInternalNetwork('10.0.1.102')).toBe(true);
  });

  it('treats 100.64/10 as private (CGNAT)', () => {
    expect(isPrivateOrInternalNetwork('100.64.0.1')).toBe(true);
    expect(isPrivateOrInternalNetwork('100.127.255.255')).toBe(true);
    expect(isPrivateOrInternalNetwork('100.63.0.1')).toBe(false);
  });
});
