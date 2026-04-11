/**
 * PUT a body to a presigned S3/MinIO URL using Node's http/https.
 *
 * Playwright's test worker uses global `fetch` (undici), which can add framing
 * or proxy behavior that breaks SigV4 presigned PUTs against local MinIO.
 * A minimal request with explicit Content-Length matches what the signature expects.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export type PresignedPutResult = {
  statusCode: number;
  statusMessage: string;
  body: string;
};

export function putPresignedObject(
  uploadUrl: string,
  body: Buffer,
  contentType: string,
): Promise<PresignedPutResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port =
      u.port !== ''
        ? Number(u.port)
        : isHttps
          ? 443
          : 80;

    const req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
