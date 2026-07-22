const BLOCKED_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'audio',
  'video',
  'source',
  'track',
  'base',
  'meta[http-equiv]',
].join(',');

const BLOCK_ELEMENTS = [
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
].join(',');

function createDocument(html) {
  return new DOMParser().parseFromString(html || '', 'text/html');
}

function isUnsafeUrl(value) {
  return /^\s*(?:javascript|vbscript|file):/i.test(value || '');
}

function contentSecurityPolicy(allowRemote) {
  const remote = allowRemote ? ' https:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

function sanitizeDocument(doc, allowRemote) {
  doc.querySelectorAll(BLOCKED_ELEMENTS).forEach((node) => node.remove());

  doc.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'ping') {
        node.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction')
        && isUnsafeUrl(attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    }
  });

  doc.querySelectorAll('link').forEach((link) => {
    const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = link.getAttribute('href') || '';
    if (!rel.includes('stylesheet') || isUnsafeUrl(href)) link.remove();
  });

  doc.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (isUnsafeUrl(href) || /^\s*data:/i.test(href)) {
      anchor.removeAttribute('href');
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });

  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', contentSecurityPolicy(allowRemote));
  head.prepend(csp);

  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset);

  const viewport = doc.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1');
  head.append(viewport);

  const guardStyles = doc.createElement('style');
  guardStyles.textContent = `
    :root { color-scheme: light; background: #fff; }
    html, body { min-height: 100%; }
    body { margin: 0; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
  `;
  head.append(guardStyles);
}

function extractPlainText(doc) {
  doc.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  doc.querySelectorAll(BLOCK_ELEMENTS).forEach((node) => node.append('\n'));
  return (doc.body?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function containsExternalContent(doc) {
  const values = [];
  doc.querySelectorAll('img[src], [srcset], link[rel~="stylesheet"][href], [style]').forEach((node) => {
    for (const name of ['src', 'srcset', 'href', 'style']) {
      const value = node.getAttribute(name);
      if (value) values.push(value);
    }
  });
  doc.querySelectorAll('style').forEach((node) => values.push(node.textContent || ''));
  return values.some((value) => /(?:https?:)?\/\//i.test(value));
}

export function buildEmailPreviewDocument(html, { allowRemote = false } = {}) {
  const source = String(html || '');
  const sourceDocument = createDocument(source);
  const hasExternalContent = containsExternalContent(sourceDocument);
  sanitizeDocument(sourceDocument, allowRemote);
  const plainText = extractPlainText(sourceDocument.cloneNode(true));

  return {
    srcdoc: `<!doctype html>\n${sourceDocument.documentElement.outerHTML}`,
    plainText,
    hasExternalContent,
  };
}
