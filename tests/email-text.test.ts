import { describe, expect, it } from 'vitest';
import {
  cleanPlainText,
  extractCleanEmailText,
  htmlToCleanText,
  stripLeakedCss,
  summarizeEmailText,
} from '../src/email/text';

const BNESIM_LEAKED_CSS = `BNESIM | Your eSIM is ready!
 
 *{box-sizing: border-box;}body{margin: 0;padding: 0;}a[x-apple-data-detectors]{color: inherit !important;text-decoration: inherit !important;}#MessageViewBody a{color: inherit;text-decoration: none;}p{line-height: inherit}.desktop_hide,.desktop_hide table{mso-hide: all;display: none;max-height: 0px;overflow: hidden;}.image_block img+div{display: none;}sup,sub{font-size: 75%;line-height: 0;}@media (max-width:620px){.row-4 .column-1 .block-3.button_block .alignment .button,.row-6 .column-2 .block-4.social_block .alignment table,.social_block.desktop_hide .social-table{display: inline-block !important;}.mobile_hide{display: none;}.row-content{width: 100% !important;}.stack .column{width: 100%;display: block;}.mobile_hide{min-height: 0;max-height: 0;max-width: 0;overflow: hidden;font-size: 0px;}.desktop_hide,.desktop_hide table{display: table !important;max-height: none !important;}}@media (max-width:620px){.esim-card{display: block !important;width: 100% !important;box-sizing: border-box !important;margin-bottom: 10px !important;}}

img.lg-d { display:none !important; }
td[style*="background-color: rgb(255,255,255)"] { border-radius:12px !important; }
table[style*="border-left: 25px solid rgb(248,248,248)"] { background-color: transparent !important; }
body[style*="margin:0; padding:0; font-family: Arial"] { padding:16px !important; }
@media (max-width:520px) { table[style*="width:500px"], td[style*="width:500px"], div[style*="width: 500px"] { width:100% !important; max-width:100% !important; } }
@media (prefers-color-scheme: dark) {
  body, .body, .nl-container, .dk-bp { background-color:#0E1526 !important; }
  [style*="background-color: #ffffff"],
  [style*="background-color:#ffffff"],
  td[style*="background-color: #f5f5f5"] { background-color:#171F33 !important; }
}

Hi Leo,
Your eSIM profile for Japan 5GB is ready to install.
Open the BNESIM app and scan your QR code to activate.`;

describe('email text extraction and cleaning', () => {
  it('strips leaked CSS and @media rules from plain text while preserving real body', () => {
    const cleaned = cleanPlainText(BNESIM_LEAKED_CSS);

    expect(cleaned).not.toContain('box-sizing');
    expect(cleaned).not.toContain('@media');
    expect(cleaned).not.toContain('prefers-color-scheme');
    expect(cleaned).not.toContain('background-color');
    expect(cleaned).toContain('BNESIM | Your eSIM is ready!');
    expect(cleaned).toContain('Your eSIM profile for Japan 5GB is ready to install.');
    expect(cleaned).toContain('Open the BNESIM app and scan your QR code to activate.');
  });

  it('handles truncated unclosed @media CSS tails cleanly', () => {
    const truncated = `BNESIM | Your eSIM is ready!

*{box-sizing: border-box;}
@media (prefers-color-scheme: dark) {
  body, .body { background-color:#0E1526 !important; }
  td[style*="background-color: #f5f5f5"],
  [st…`;

    const cleaned = cleanPlainText(truncated);
    expect(cleaned).toBe('BNESIM | Your eSIM is ready!');
  });

  it('prefers clean HTML extraction when text_body is polluted with leaked CSS', () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>BNESIM | Your eSIM is ready!</title>
          <style>
            *{box-sizing: border-box;}
            @media (prefers-color-scheme: dark) { body { background-color:#0E1526 !important; } }
          </style>
        </head>
        <body>
          <div style="display:none;max-height:0;overflow:hidden;">Hidden preheader &zwnj;&nbsp;&zwnj;</div>
          <!--[if mso]><table><tr><td>MSO only</td></tr></table><![endif]-->
          <h1>Your eSIM is ready!</h1>
          <p>Install your <strong>Japan 5GB</strong> plan directly from the BNESIM app.</p>
          <p>Order ID: <code>#BNE-90210</code></p>
        </body>
      </html>`;

    const extracted = extractCleanEmailText({
      text_body: BNESIM_LEAKED_CSS.slice(0, 1200),
      html_body: html,
      subject: 'Thanks, your eSIM is ready',
    });

    expect(extracted).not.toContain('box-sizing');
    expect(extracted).not.toContain('Hidden preheader');
    expect(extracted).not.toContain('MSO only');
    expect(extracted).toContain('Your eSIM is ready!');
    expect(extracted).toContain('Install your Japan 5GB plan directly from the BNESIM app.');
    expect(extracted).toContain('Order ID: #BNE-90210');
  });

  it('converts HTML emails cleanly, decoding entities and stripping invisible preheader chars', () => {
    const html = `
      <style>body { color: red; }</style>
      <script>alert(1)</script>
      <p>Hello&nbsp;&amp;&nbsp;welcome&#33;\u200b\u200c\ufeff</p>
      <ul>
        <li>Item&#x20;One</li>
        <li>Item Two</li>
      </ul>`;

    const cleaned = htmlToCleanText(html);
    expect(cleaned).toBe('Hello & welcome!\n\n• Item One\n• Item Two');
  });

  it('does not strip JSON objects or template placeholders in normal developer emails', () => {
    const devEmail = [
      'Webhook delivery succeeded.',
      'Payload: {"status": "ok", "count": 3}',
      'Use {code} to confirm.',
    ].join('\n');

    expect(stripLeakedCss(devEmail)).toBe(devEmail);
    expect(cleanPlainText(devEmail)).toBe(devEmail);
  });

  it('cleans noisy tracking URLs while keeping short links readable', () => {
    const longTracker = 'https://click.mail.example.com/ls/click?upn=' + 'a'.repeat(160);
    const text = [
      `Activate eSIM [${longTracker}]`,
      `Standalone: ${longTracker}`,
      'Short link: https://example.com/verify',
    ].join('\n');

    const cleaned = cleanPlainText(text);
    expect(cleaned).not.toContain('a'.repeat(40));
    expect(cleaned).toContain('Activate eSIM');
    expect(cleaned).toContain('Standalone: https://click.mail.example.com/…');
    expect(cleaned).toContain('Short link: https://example.com/verify');
  });

  it('strips trailing footer boilerplate and truncates cleanly at natural boundaries', () => {
    const body = [
      'Your invoice #INV-2026-01 for $19.00 has been paid successfully.',
      '',
      'You can download the PDF receipt anytime from your billing portal.',
      '',
      'You are receiving this email because you subscribed to billing alerts.',
      'Unsubscribe | Privacy Policy',
    ].join('\n');

    const summary = summarizeEmailText(body, 600);
    expect(summary).toContain('Your invoice #INV-2026-01');
    expect(summary).toContain('download the PDF receipt');
    expect(summary).not.toContain('You are receiving this email');
    expect(summary).not.toContain('Unsubscribe');

    const longBody = '这是第一段完整的通知内容，说明订单已经发货。'.repeat(25);
    const bounded = summarizeEmailText(longBody, 120);
    expect(bounded.length).toBeLessThanOrEqual(120);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded).not.toContain('\ufffd');
  });
});
