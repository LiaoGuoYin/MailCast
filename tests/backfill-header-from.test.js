import { describe, expect, it } from 'vitest';
import { headerFromAddress } from '../scripts/backfill-header-from.mjs';

describe('backfill header From', () => {
  it('reads the header From from a stored raw prefix, ignoring the body', async () => {
    const raw = 'Received: from x\r\nFrom: "GitHub" <noreply@github.com>\r\nSubject: Hi\r\n\r\nFrom: body@example.com\r\n';
    await expect(headerFromAddress(raw)).resolves.toBe('noreply@github.com');
  });

  it('handles LF-only headers and returns empty when no usable From exists', async () => {
    await expect(headerFromAddress('From: a@example.com\nSubject: x\n\nbody')).resolves.toBe('a@example.com');
    await expect(headerFromAddress('From: undisclosed\r\nSubject: x\r\n\r\n')).resolves.toBe('');
    await expect(headerFromAddress('')).resolves.toBe('');
  });
});
