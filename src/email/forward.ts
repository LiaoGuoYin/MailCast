import { errorDescription, errorProperty } from './errors';

const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface ForwardSource {
  from_addr: string;
  to_addr: string;
  subject: string;
  text_body: string;
  html_body: string;
  body_truncated: boolean;
  created_at: string;
}

export interface ForwardedEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function validateEmailAddress(value: string): string | null {
  if (!value) return '请输入收件邮箱';
  if (value.length > 254 || !EMAIL_ADDRESS_RE.test(value)) {
    return '请输入有效的收件邮箱';
  }
  return null;
}

export function forwardedSubject(subject: string): string {
  const value = subject.trim() || '（无主题）';
  return /^fwd?:\s*/i.test(value) ? value : `Fwd: ${value}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildForwardedEmail(email: ForwardSource): ForwardedEmailContent {
  const headerLines = [
    '---------- Forwarded message ----------',
    `From: ${email.from_addr}`,
    `To: ${email.to_addr}`,
    `Date: ${email.created_at}`,
    `Subject: ${email.subject || '（无主题）'}`,
  ];
  const truncatedNotice = email.body_truncated ? '（注意：原邮件正文因存储上限已截断）\n\n' : '';
  const fallbackText = `${truncatedNotice}${email.text_body || stripHtml(email.html_body) || '（原邮件正文为空）'}`;
  const htmlBody = email.html_body
    ? `${email.body_truncated ? '<p style="color:#b45309"><strong>注意：</strong>原邮件正文因存储上限已截断。</p>' : ''}${email.html_body}`
    : `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(fallbackText)}</pre>`;
  const headerHtml = headerLines
    .slice(1)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');

  return {
    subject: forwardedSubject(email.subject),
    text: `${headerLines.join('\n')}\n\n${fallbackText}`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:13px;color:#555;margin:0 0 16px">`
      + `<div style="font-weight:600;margin-bottom:6px">Forwarded message</div>${headerHtml}</div>`
      + `<hr style="border:0;border-top:1px solid #ddd;margin:0 0 16px">${htmlBody}`,
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>|<\/div\s*>|<\/li\s*>|<\/tr\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface EmailSendErrorPayload {
  error: string;
  email: {
    code: string;
    description: string;
  };
}

export function emailSendErrorPayload(error: unknown): EmailSendErrorPayload {
  const description = errorDescription(error, 'Unknown Email Sending error');
  const code = errorProperty(error, 'code');
  const name = errorProperty(error, 'name');
  const codeValue = code ?? name ?? 'EMAIL_SEND_FAILED';

  return {
    error: '邮件转发失败',
    email: {
      code: String(codeValue).slice(0, 100),
      description: description.slice(0, 500),
    },
  };
}
