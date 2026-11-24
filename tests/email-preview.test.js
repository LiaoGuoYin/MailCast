import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildEmailPreviewDocument, previewScale } from '../public/email-preview.js';

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

  it('keeps inline formatting and produces readable fallback text without leaked styles', () => {
    const result = buildEmailPreviewDocument(
      '<body><style>body{margin:0;}</style><p>Hello<br><strong>world</strong></p></body>',
    );

    expect(result.srcdoc).toContain('<strong>world</strong>');
    expect(result.plainText).toBe('Hello\nworld');
    expect(result.hasExternalContent).toBe(false);
  });

  it('strips 1x1 and hidden tracking pixels while preserving normal images', () => {
    const html = `
      <body>
        <img src="https://track.example/open.gif" width="1" height="1">
        <img src="https://track.example/zero.gif" style="display:none">
        <img src="https://cdn.example/logo.png" width="120" height="40">
      </body>`;
    const result = buildEmailPreviewDocument(html, { allowRemote: true });
    const doc = new DOMParser().parseFromString(result.srcdoc, 'text/html');
    const images = [...doc.querySelectorAll('img')];

    expect(result.strippedTrackers).toBe(2);
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('https://cdn.example/logo.png');
  });
});

describe('HTML email preview fitting', () => {
  it('shrinks fixed-width emails to the available width', () => {
    expect(previewScale(600, 390)).toBeCloseTo(0.65);
    expect(previewScale(390, 390)).toBe(1);
    expect(previewScale(320, 390)).toBe(1);
  });

  it('stops shrinking at a readable minimum', () => {
    expect(previewScale(2000, 390)).toBe(0.4);
  });

  it('leaves unmeasurable frames unscaled', () => {
    expect(previewScale(0, 390)).toBe(1);
    expect(previewScale(600, 0)).toBe(1);
  });

  it('keeps scripts disabled in the same-origin preview sandbox', () => {
    // allow-same-origin is only safe without allow-scripts; see emails-view.js.
    const source = readFileSync('public/emails-view.js', 'utf8');
    const sandbox = source.match(/sandbox="([^"]*)"/)?.[1] ?? '';

    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
  });
});
