import { describe, expect, it } from 'vitest';
import { buildEmailPreviewDocument } from '../public/email-preview.js';

describe('HTML email preview document', () => {
  const hostileHtml = `
    <!doctype html>
    <html>
      <head>
        <meta http-equiv="refresh" content="0;url=https://evil.example">
        <style>.hero { background-image: url(https://img.example/track.png); }</style>
      </head>
      <body onload="window.parent.pwned = true">
        <script>window.parent.pwned = true</script>
        <form action="https://evil.example"><input name="secret"></form>
        <iframe></iframe>
        <img src="https://img.example/pixel.gif" onerror="alert(1)">
        <a href="https://example.com" ping="https://evil.example/ping">Open</a>
      </body>
    </html>`;

  it('removes active content and hardens links', () => {
    const result = buildEmailPreviewDocument(hostileHtml);
    const doc = new DOMParser().parseFromString(result.srcdoc, 'text/html');
    const link = doc.querySelector('a');

    expect(doc.querySelector('script, form, iframe, input')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('[onload], [onerror], [ping]')).toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(result.plainText).not.toContain('window.parent');
  });

  it('blocks remote resources until explicitly enabled', () => {
    const blocked = buildEmailPreviewDocument(hostileHtml);
    const allowed = buildEmailPreviewDocument(hostileHtml, { allowRemote: true });
    const blockedDoc = new DOMParser().parseFromString(blocked.srcdoc, 'text/html');
    const allowedDoc = new DOMParser().parseFromString(allowed.srcdoc, 'text/html');
    const blockedCsp = blockedDoc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
    const allowedCsp = allowedDoc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';

    expect(blocked.hasExternalContent).toBe(true);
    expect(blockedCsp).toContain("img-src data: blob:");
    expect(blockedCsp).not.toContain('blob: https:');
    expect(allowedCsp).toContain('img-src data: blob: https:');
    expect(allowedCsp).toContain("script-src 'none'");
  });

  it('keeps inline formatting and produces readable fallback text', () => {
    const result = buildEmailPreviewDocument('<p>Hello<br><strong>world</strong></p>');

    expect(result.srcdoc).toContain('<strong>world</strong>');
    expect(result.plainText).toBe('Hello\nworld');
    expect(result.hasExternalContent).toBe(false);
  });
});
