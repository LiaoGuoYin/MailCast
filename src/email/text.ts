const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  laquo: '«',
  raquo: '»',
  zwnj: '',
  zwj: '',
  shy: '',
  lrm: '',
  rlm: '',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
};

const INVISIBLE_CHARS_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\ufeff\uffa0]/g;

const SKIP_HTML_TAGS = new Set([
  'head',
  'style',
  'script',
  'noscript',
  'template',
  'svg',
  'title',
  'iframe',
  'object',
  'embed',
  'canvas',
  'math',
]);

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const PARAGRAPH_HTML_TAGS = new Set([
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ol',
  'p',
  'pre',
  'ul',
]);

const LINE_BREAK_HTML_TAGS = new Set([
  'address',
  'article',
  'aside',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'main',
  'nav',
  'section',
  'table',
  'tr',
]);

const KNOWN_CSS_PROPERTIES = new Set([
  'align-items',
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'border',
  'border-bottom',
  'border-collapse',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-spacing',
  'border-style',
  'border-top',
  'border-width',
  'bottom',
  'box-shadow',
  'box-sizing',
  'clear',
  'color',
  'color-scheme',
  'content',
  'cursor',
  'display',
  'fill',
  'flex',
  'flex-direction',
  'float',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid',
  'height',
  'justify-content',
  'left',
  'letter-spacing',
  'line-height',
  'list-style',
  'list-style-type',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'mso-hide',
  'mso-line-height-rule',
  'mso-padding-alt',
  'mso-table-lspace',
  'mso-table-rspace',
  'opacity',
  'outline',
  'overflow',
  'overflow-wrap',
  'overflow-x',
  'overflow-y',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'stroke',
  'table-layout',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-overflow',
  'text-size-adjust',
  'text-transform',
  'top',
  'transform',
  'transition',
  'vertical-align',
  'visibility',
  'white-space',
  'width',
  'word-break',
  'word-wrap',
  'z-index',
]);

const FOOTER_MARKER_PATTERNS = [
  /^(?:unsubscribe|manage\s+(?:your\s+)?(?:email\s+)?preferences|email\s+preferences|opt[\s-]?out)\b/i,
  /^you\s+are\s+receiving\s+this\s+(?:email|message)\s+because\b/i,
  /^this\s+(?:email|message)\s+was\s+sent\s+to\b/i,
  /^please\s+do\s+not\s+reply\s+to\s+this\s+(?:email|message)\b/i,
  /^if\s+you\s+(?:no\s+longer\s+wish|don't\s+want)\s+to\s+receive\b/i,
  /^(?:©|copyright\s+©?)\s*\d{4}\b/i,
  /^(?:privacy\s+policy|terms\s+of\s+(?:service|use))\s*[|·•/]/i,
  /^(?:此邮件由系统自动发送|本邮件由系统自动发出|请勿直接回复此邮件|如不想继续接收|退订|取消订阅)/,
];

const HTML_SIGNATURE_RE = /<(?:!doctype|html|head|body|style|script|table|tr|td|div|p|br|span|a\s+href|img\s+src|meta)\b/i;
const CSS_AT_RULE_BLOCK_RE = /@(?:media|supports|(?:-webkit-|-moz-|-o-)?keyframes|font-face|page|layer|container|scope|(?:-moz-)?document)\b/gi;
const CSS_AT_RULE_INLINE_RE = /@(?:import|charset|namespace)\s+[^;\n]{1,400};/gi;
const CSS_VALUE_HINT_RE = /!important\b|\b\d+(?:\.\d+)?(?:px|pt|em|rem|vh|vw|%)\b|#[0-9a-f]{3,8}\b|\brgba?\s*\(|\b(?:border-box|inherit|transparent|inline-block|none|hidden|solid)\b/i;

export const DEFAULT_TG_SUMMARY_MAX_CHARS = 600;
export const DEFAULT_BARK_SUMMARY_MAX_CHARS = 400;

export function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (match, hex, dec, named) => {
    if (named) {
      const key = named.toLowerCase();
      return key in NAMED_HTML_ENTITIES ? NAMED_HTML_ENTITIES[key] : match;
    }
    const codePoint = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return match;
    }
    if (codePoint === 0xa0) return ' ';
    if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
      return String.fromCodePoint(codePoint);
    }
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return '';
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

export function stripInvisibleChars(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(INVISIBLE_CHARS_RE, '');
}

function isHiddenElement(attrs: string): boolean {
  if (!attrs) return false;
  if (/(?:^|\s)hidden(?:\s*=|\s|$)/i.test(attrs)) return true;

  const styleMatch = attrs.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!styleMatch) return false;
  const style = (styleMatch[1] ?? styleMatch[2] ?? styleMatch[3] ?? '').toLowerCase();
  if (!style) return false;

  if (/(?:^|;)\s*display\s*:\s*none\b/.test(style)) return true;
  if (/(?:^|;)\s*visibility\s*:\s*hidden\b/.test(style)) return true;
  if (/(?:^|;)\s*mso-hide\s*:\s*all\b/.test(style)) return true;
  if (/(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*(?:;|$)/.test(style)) return true;

  const zeroMaxHeight = /(?:^|;)\s*max-height\s*:\s*0(?:px|em|rem|%)?\s*(?:!important)?\s*(?:;|$)/.test(style);
  const zeroFontSize = /(?:^|;)\s*font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:!important)?\s*(?:;|$)/.test(style);
  const hiddenOverflow = /(?:^|;)\s*overflow\s*:\s*hidden\b/.test(style);
  const zeroLineHeight = /(?:^|;)\s*line-height\s*:\s*0(?:px|em|rem|%)?\s*(?:!important)?\s*(?:;|$)/.test(style);

  return (zeroMaxHeight && hiddenOverflow) || (zeroFontSize && (zeroLineHeight || zeroMaxHeight));
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | '' = '';
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Convert an HTML email into clean, readable plain text.
 * Drops <head>, <style>, <script>, <title>, <svg>, HTML/MSO comments,
 * and hidden preheader containers without relying on a DOM runtime.
 */
export function htmlToCleanText(html: string): string {
  if (!html) return '';

  const chunks: string[] = [];
  let i = 0;
  let skipTag = '';
  let skipDepth = 0;
  let hiddenTag = '';
  let hiddenDepth = 0;
  let preDepth = 0;

  const pushText = (raw: string) => {
    const decoded = decodeHtmlEntities(raw);
    chunks.push(preDepth > 0 ? decoded : decoded.replace(/[ \t\r\n]+/g, ' '));
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (!skipTag && !hiddenTag) {
        pushText(html.slice(i));
      }
      break;
    }

    if (lt > i && !skipTag && !hiddenTag) {
      pushText(html.slice(i, lt));
    }

    // HTML / MSO comments
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      if (commentEnd === -1) break;
      i = commentEnd + 3;
      continue;
    }

    // CDATA sections
    if (html.startsWith('<![CDATA[', lt)) {
      const cdataEnd = html.indexOf(']]>', lt + 9);
      if (cdataEnd === -1) {
        if (!skipTag && !hiddenTag) chunks.push(html.slice(lt + 9));
        break;
      }
      if (!skipTag && !hiddenTag) chunks.push(html.slice(lt + 9, cdataEnd));
      i = cdataEnd + 3;
      continue;
    }

    // Declarations / processing instructions (<!DOCTYPE ...>, <?xml ...?>)
    const nextChar = html[lt + 1] ?? '';
    if (nextChar === '!' || nextChar === '?') {
      const declEnd = html.indexOf('>', lt + 2);
      if (declEnd === -1) break;
      i = declEnd + 1;
      continue;
    }

    // Bare '<' not starting a tag (e.g. "x < 5")
    if (!/[a-zA-Z/]/.test(nextChar)) {
      if (!skipTag && !hiddenTag) chunks.push('<');
      i = lt + 1;
      continue;
    }

    const gt = findTagEnd(html, lt + 1);
    if (gt === -1) {
      // Truncated tag at end of HTML; drop it rather than leaking raw markup.
      break;
    }

    const rawTag = html.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!rawTag) continue;
    const isClose = rawTag.startsWith('/');
    const body = isClose ? rawTag.slice(1).trim() : rawTag;
    const nameMatch = body.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) continue;

    const tagName = nameMatch[1].toLowerCase();
    const isSelfClosing = !isClose && (rawTag.endsWith('/') || VOID_HTML_TAGS.has(tagName));
    const attrs = isClose ? '' : body.slice(nameMatch[0].length);

    if (skipTag) {
      if (tagName === skipTag) {
        if (isClose) {
          skipDepth -= 1;
          if (skipDepth <= 0) {
            skipTag = '';
            skipDepth = 0;
          }
        } else if (!isSelfClosing) {
          skipDepth += 1;
        }
      }
      continue;
    }

    if (hiddenTag) {
      if (tagName === hiddenTag) {
        if (isClose) {
          hiddenDepth -= 1;
          if (hiddenDepth <= 0) {
            hiddenTag = '';
            hiddenDepth = 0;
          }
        } else if (!isSelfClosing) {
          hiddenDepth += 1;
        }
      }
      continue;
    }

    if (!isClose && !isSelfClosing && SKIP_HTML_TAGS.has(tagName)) {
      skipTag = tagName;
      skipDepth = 1;
      continue;
    }

    if (!isClose && !isSelfClosing && isHiddenElement(attrs)) {
      hiddenTag = tagName;
      hiddenDepth = 1;
      continue;
    }

    if (tagName === 'pre') {
      if (isClose) preDepth = Math.max(0, preDepth - 1);
      else if (!isSelfClosing) preDepth += 1;
    }

    if (tagName === 'br' || tagName === 'hr') {
      chunks.push('\n');
    } else if (tagName === 'li') {
      chunks.push(isClose ? '\n' : '\n• ');
    } else if (PARAGRAPH_HTML_TAGS.has(tagName)) {
      chunks.push('\n\n');
    } else if (LINE_BREAK_HTML_TAGS.has(tagName)) {
      chunks.push('\n');
    } else if (tagName === 'td' || tagName === 'th') {
      chunks.push(' ');
    }
  }

  // Collapse excessive single-newline runs around explicit paragraph breaks
  // while keeping list items and adjacent lines compact.
  return normalizeCleanText(
    chunks
      .join('')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/(\n• [^\n]+)\n{2,}(• )/g, '$1\n$2'),
  );
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '' = '';
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const endComment = text.indexOf('*/', i + 2);
      if (endComment === -1) return -1;
      i = endComment + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitCssDeclarations(block: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let parenDepth = 0;

  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < block.length) {
        current += block[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '/' && block[i + 1] === '*') {
      const endComment = block.indexOf('*/', i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(') {
      parenDepth += 1;
      current += ch;
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += ch;
    } else if (ch === ';' && parenDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function isCssDeclarationBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return false;
  const declarations = splitCssDeclarations(trimmed);
  if (declarations.length === 0) return false;

  let validCount = 0;
  let cssSignalCount = 0;
  for (const decl of declarations) {
    const colon = decl.indexOf(':');
    if (colon <= 0) return false;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!val) return false;
    if (!/^(?:--?[a-z0-9-]+|[a-z][a-z0-9-]*)$/.test(prop)) return false;

    validCount += 1;
    const normalizedProp = prop.replace(/^-(?:webkit|moz|ms|o)-/, '');
    if (KNOWN_CSS_PROPERTIES.has(normalizedProp) || CSS_VALUE_HINT_RE.test(val)) {
      cssSignalCount += 1;
    }
  }

  return validCount === declarations.length && cssSignalCount > 0;
}

function findCssSelectorStart(text: string, openBrace: number): number {
  let i = openBrace - 1;
  while (i >= 0 && /[ \t\r\n]/.test(text[i])) i -= 1;
  if (i < 0) return -1;

  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | '' = '';
  let start = i;

  while (i >= 0) {
    const ch = text[i];

    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') {
        quote = '';
      }
      start = i;
      i -= 1;
      continue;
    }

    if (bracketDepth > 0) {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ']') bracketDepth += 1;
      else if (ch === '[') bracketDepth -= 1;
      start = i;
      i -= 1;
      continue;
    }

    if (parenDepth > 0) {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ')') parenDepth += 1;
      else if (ch === '(') parenDepth -= 1;
      start = i;
      i -= 1;
      continue;
    }

    if (ch === ']') {
      bracketDepth = 1;
      start = i;
      i -= 1;
      continue;
    }

    if (ch === ')') {
      parenDepth = 1;
      start = i;
      i -= 1;
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      let prev = i - 1;
      while (prev >= 0 && /[ \t\r]/.test(text[prev])) prev -= 1;
      if (prev >= 0 && (text[prev] === ',' || text[prev] === '>' || text[prev] === '+' || text[prev] === '~')) {
        start = i;
        i -= 1;
        continue;
      }
      break;
    }

    if (/[a-zA-Z0-9_\-.*#:,>+~ \t]/.test(ch)) {
      start = i;
      i -= 1;
      continue;
    }

    break;
  }

  if (bracketDepth !== 0 || parenDepth !== 0 || quote) return -1;

  const selector = text.slice(start, openBrace).trim();
  if (!selector || selector.length > 1500) return -1;
  if (!/[a-zA-Z*#.\[]/.test(selector)) return -1;
  // Avoid matching prose sentences before an accidental "{key: val}"
  if (/[?!。！？]/.test(selector)) return -1;
  return start;
}

/**
 * Remove leaked CSS blocks (both @media/@supports nested blocks and regular
 * `selector { prop: val; }` rules) from plain-text email bodies where the
 * sender naively stripped HTML tags without stripping <style> contents.
 */
export function stripLeakedCss(text: string): string {
  if (!text || (!text.includes('{') && !text.includes('@'))) return text;

  let result = text.replace(CSS_AT_RULE_INLINE_RE, '\n');
  let strippedAny = result !== text;

  // 1. Strip nested CSS @-rule blocks (@media, @supports, @keyframes, @font-face, ...)
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    CSS_AT_RULE_BLOCK_RE.lastIndex = 0;
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = CSS_AT_RULE_BLOCK_RE.exec(result)) !== null) {
      const start = match.index;
      if (start < cursor) continue;

      const openBrace = result.indexOf('{', start + match[0].length);
      if (openBrace === -1 || openBrace - start > 300) continue;
      const prelude = result.slice(start + match[0].length, openBrace);
      if (prelude.includes('\n\n') || prelude.includes('}')) continue;

      const closeBrace = findMatchingBrace(result, openBrace);
      if (closeBrace !== -1) {
        out += result.slice(cursor, start) + '\n';
        cursor = closeBrace + 1;
        CSS_AT_RULE_BLOCK_RE.lastIndex = cursor;
        changed = true;
        strippedAny = true;
      } else {
        // Unclosed @media block (e.g. truncated mid-CSS); drop tail if it looks like CSS.
        const tail = result.slice(openBrace + 1);
        if (CSS_VALUE_HINT_RE.test(tail) || /style\s*\*=/i.test(tail) || tail.includes('{')) {
          out += result.slice(cursor, start) + '\n';
          cursor = result.length;
          changed = true;
          strippedAny = true;
          break;
        }
      }
    }

    if (!changed) break;
    out += result.slice(cursor);
    result = out;
  }

  // 2. Strip flat CSS rule blocks (`selector { prop: val; }`)
  let out = '';
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < result.length) {
    const openBrace = result.indexOf('{', searchFrom);
    if (openBrace === -1) break;

    const closeBrace = findMatchingBrace(result, openBrace);
    if (closeBrace === -1) {
      // Unclosed CSS declaration tail after we already detected CSS earlier.
      const tail = result.slice(openBrace + 1);
      const selStart = findCssSelectorStart(result, openBrace);
      if (
        strippedAny
        && selStart >= cursor
        && (CSS_VALUE_HINT_RE.test(tail) || /:\s*[^:\n]+;/.test(tail))
      ) {
        out += result.slice(cursor, selStart) + '\n';
        cursor = result.length;
      }
      break;
    }

    const inside = result.slice(openBrace + 1, closeBrace);
    if (!inside.includes('{') && isCssDeclarationBlock(inside)) {
      const selStart = findCssSelectorStart(result, openBrace);
      if (selStart >= cursor) {
        out += result.slice(cursor, selStart) + '\n';
        cursor = closeBrace + 1;
        searchFrom = cursor;
        strippedAny = true;
        continue;
      }
    }

    searchFrom = openBrace + 1;
  }

  out += result.slice(cursor);
  result = out;

  // 3. If CSS was stripped and only a truncated trailing selector fragment remains
  // (e.g. `td[style*="background-color: #f5f5f5"], [st…`), remove that tail too.
  if (strippedAny) {
    result = result.replace(/(?:^|\n)[ \t]*(?:[a-zA-Z0-9_.*#>-]*\[style[^\n]*,?\s*)+\[?[a-zA-Z0-9_-]*…?\s*$/g, '\n');
  }

  return result;
}

function cleanNoisyUrls(text: string): string {
  // Drop long inline bracketed/angle-bracketed tracking links like "[https://click.example.com/...]"
  let cleaned = text.replace(/[\[(<](https?:\/\/[^\s\]>)>]+)[\])>]/gi, (match, url: string) => {
    if (url.length > 80 || /[?&](?:utm_|upn=|mc_eid=|trk=|token=|sig=)/i.test(url)) {
      return '';
    }
    return match;
  });

  // Shorten remaining excessively long standalone URLs while keeping domain readable
  cleaned = cleaned.replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => {
    if (url.length <= 100) return url;
    try {
      const parsed = new URL(url);
      return `${parsed.origin}/…`;
    } catch {
      return `${url.slice(0, 60)}…`;
    }
  });

  return cleaned;
}

export function normalizeCleanText(value: string): string {
  const prepared = cleanNoisyUrls(
    stripLeakedCss(
      stripInvisibleChars(value)
        .replace(/\r\n?/g, '\n'),
    ),
  );

  const lines: string[] = [];
  let prevNonEmptyLower = '';
  let blankRun = 0;

  for (const rawLine of prepared.split('\n')) {
    const line = rawLine
      .replace(/\[(?:image|cid):[^\]]*\]/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    if (!line) {
      if (lines.length > 0 && blankRun === 0) {
        lines.push('');
      }
      blankRun += 1;
      continue;
    }

    // Drop decorative separator lines (e.g. "--------", "========", "________")
    if (/^[-=_*•·~—–]{4,}$/.test(line)) {
      continue;
    }

    const lowered = line.toLowerCase();
    if (lowered === prevNonEmptyLower) {
      continue;
    }

    lines.push(line);
    prevNonEmptyLower = lowered;
    blankRun = 0;
  }

  return lines.join('\n').trim();
}

export function cleanPlainText(text: string): string {
  if (!text) return '';
  return normalizeCleanText(decodeHtmlEntities(text));
}

function looksLikeHtml(value: string): boolean {
  return HTML_SIGNATURE_RE.test(value);
}

function hasLeakedCss(value: string): boolean {
  if (!value.includes('{') && !value.includes('@media')) return false;
  const stripped = stripLeakedCss(value);
  const removedChars = value.length - stripped.length;
  return removedChars >= 80 || (value.length > 0 && removedChars / value.length >= 0.25);
}

function stripLeadingDuplicateSubject(text: string, subject?: string): string {
  const normalizedSubject = subject?.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalizedSubject) return text;
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) return text;

  const firstLine = text.slice(0, firstNewline).trim().replace(/\s+/g, ' ').toLowerCase();
  const rest = text.slice(firstNewline + 1).trim();
  if (rest && firstLine === normalizedSubject) {
    return rest;
  }
  return text;
}

/**
 * Extract clean human-readable text from an email's text/HTML bodies.
 * Automatically prefers clean HTML extraction when text_body is empty,
 * contains raw HTML, or is polluted with leaked CSS from naive converters.
 */
export function extractCleanEmailText(input: {
  text_body?: string;
  html_body?: string;
  subject?: string;
}): string {
  const rawText = (input.text_body ?? '').trim();
  const rawHtml = (input.html_body ?? '').trim();

  if (rawHtml && (!rawText || looksLikeHtml(rawText) || hasLeakedCss(rawText))) {
    const fromHtml = htmlToCleanText(rawHtml);
    if (fromHtml) {
      return stripLeadingDuplicateSubject(fromHtml, input.subject);
    }
  }

  if (rawText) {
    const fromText = looksLikeHtml(rawText) ? htmlToCleanText(rawText) : cleanPlainText(rawText);
    if (fromText) {
      return stripLeadingDuplicateSubject(fromText, input.subject);
    }
  }

  if (rawHtml) {
    const fromHtml = htmlToCleanText(rawHtml);
    if (fromHtml) {
      return stripLeadingDuplicateSubject(fromHtml, input.subject);
    }
  }

  return '';
}

function stripTrailingFooterBoilerplate(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 4) return text;

  let contentCharsBefore = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (
      contentCharsBefore >= 80
      && line
      && FOOTER_MARKER_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      return lines.slice(0, i).join('\n').trim();
    }
    contentCharsBefore += line.length;
  }
  return text;
}

function removeDanglingSurrogate(value: string): string {
  if (!value) return value;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? value.slice(0, -1) : value;
}

/**
 * Build a concise, cleanly-bounded summary excerpt from cleaned email text.
 * Never cuts mid-word or mid-surrogate and strips common email footer noise.
 */
export function summarizeEmailText(
  cleanText: string,
  maxChars = DEFAULT_TG_SUMMARY_MAX_CHARS,
): string {
  const stripped = stripTrailingFooterBoilerplate(cleanText.trim());
  if (!stripped) return '';
  if (stripped.length <= maxChars) return stripped;

  const budget = Math.max(20, maxChars - 1);
  const slice = removeDanglingSurrogate(stripped.slice(0, budget));
  const minBoundary = Math.floor(budget * 0.5);

  // 1. Prefer paragraph boundary
  const paragraphBreak = slice.lastIndexOf('\n\n');
  if (paragraphBreak >= minBoundary) {
    return `${slice.slice(0, paragraphBreak).trimEnd()}…`;
  }

  // 2. Prefer line break or sentence boundary
  const lineBreak = slice.lastIndexOf('\n');
  let sentenceEnd = -1;
  const sentenceMatches = slice.matchAll(/[。！？.!?](?:\s|$)/g);
  for (const match of sentenceMatches) {
    if (match.index !== undefined && match.index >= minBoundary) {
      sentenceEnd = match.index + 1;
    }
  }
  const bestBreak = Math.max(lineBreak, sentenceEnd);
  if (bestBreak >= minBoundary) {
    return `${slice.slice(0, bestBreak).trimEnd()}…`;
  }

  // 3. Avoid cutting an ASCII word in half
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= Math.floor(budget * 0.75)) {
    return `${slice.slice(0, lastSpace).trimEnd()}…`;
  }

  return `${slice.trimEnd()}…`;
}
