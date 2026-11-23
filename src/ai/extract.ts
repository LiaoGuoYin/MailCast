import type { AiConfig, Env } from '../types';
import { extractCleanEmailText } from '../email/text';

export interface EmailAiAnalysis {
  code: string | null;
  summary: string | null;
}

const ANALYSIS_SYSTEM_PROMPT =
  'You analyze incoming emails for concise mobile push notifications. ' +
  'Extract two fields:\n' +
  '1. CODE: the verification code / OTP / one-time passcode if the email contains one ' +
  '(letters, digits, or hyphens only, 4-12 chars, no spaces), otherwise NONE.\n' +
  '2. SUMMARY: a concise summary in Simplified Chinese (1-3 short sentences, under 200 characters) ' +
  'capturing the core purpose and key details (action needed, order/status/amount/date/account if present). ' +
  'Preserve original product names, order IDs, amounts, domains, and codes. ' +
  'Never include CSS, HTML, legal disclaimers, or unsubscribe boilerplate.\n\n' +
  'Reply ONLY in this exact two-line format:\n' +
  'CODE: <code or NONE>\n' +
  'SUMMARY: <concise summary>';

const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const AI_INPUT_MAX_CHARS = 6000;
const AI_SUMMARY_MAX_CHARS = 400;

function resolvedModel(config: AiConfig): string {
  if (config.provider === 'workers-ai') return config.model || DEFAULT_WORKERS_AI_MODEL;
  if (config.provider === 'openai') return config.model || DEFAULT_OPENAI_MODEL;
  return '';
}

function parseCodeValue(raw: string): string | null {
  const answer = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!answer || /^(?:none|null|n\/a|无|没有)\b/i.test(answer)) return null;
  const match = answer.match(/[A-Z0-9][A-Z0-9-]{3,11}/i);
  if (!match) return null;
  const candidate = match[0];
  if (/^(?:none|null)$/i.test(candidate)) return null;
  return candidate;
}

function parseSummaryValue(raw: string): string | null {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned || /^(?:none|null|n\/a)$/i.test(cleaned)) return null;
  return cleaned.length <= AI_SUMMARY_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, AI_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

export function parseAiAnalysisResponse(rawText: string): EmailAiAnalysis {
  const unwrapped = rawText
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!unwrapped) return { code: null, summary: null };

  // Support JSON output in case a model replies in JSON format
  if (unwrapped.startsWith('{') && unwrapped.endsWith('}')) {
    try {
      const parsed = JSON.parse(unwrapped) as { code?: unknown; summary?: unknown };
      const code = typeof parsed.code === 'string' ? parseCodeValue(parsed.code) : null;
      const summary = typeof parsed.summary === 'string' ? parseSummaryValue(parsed.summary) : null;
      if (code !== null || summary !== null) {
        return { code, summary };
      }
    } catch {
      // Fall through to line-based parser
    }
  }

  let code: string | null = null;
  let summary: string | null = null;

  const codeMatch = unwrapped.match(/(?:^|\n)\s*(?:CODE|验证码)\s*[:：]\s*([^\n]*)/i);
  if (codeMatch) {
    code = parseCodeValue(codeMatch[1]);
  }

  const summaryMatch = unwrapped.match(/(?:^|\n)\s*(?:SUMMARY|摘要)\s*[:：]\s*([\s\S]*)$/i);
  if (summaryMatch) {
    // Strip any trailing CODE line if the model swapped the order
    const summaryText = summaryMatch[1].replace(/\n\s*(?:CODE|验证码)\s*[:：][\s\S]*$/i, '');
    summary = parseSummaryValue(summaryText);
  }

  // Backwards-compatible fallback if a model only returns a bare code
  if (!codeMatch && !summaryMatch) {
    const bareCode = unwrapped.length <= 20 ? parseCodeValue(unwrapped) : null;
    if (bareCode && bareCode === unwrapped.trim()) {
      return { code: bareCode, summary: null };
    }
  }

  return { code, summary };
}

// Core AI call. Throws on provider/network failure so callers can choose
// whether to surface the error or fall back cleanly.
async function runAiAnalysis(
  env: Env,
  config: AiConfig,
  subject: string,
  body: string,
): Promise<EmailAiAnalysis> {
  if (config.provider === 'none') return { code: null, summary: null };

  const cleanBody = extractCleanEmailText({ text_body: body, subject });
  if (!subject.trim() && !cleanBody) return { code: null, summary: null };

  const content = `Subject: ${subject}\n\n${cleanBody.slice(0, AI_INPUT_MAX_CHARS)}`;
  const messages = [
    { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
  let text = '';

  if (config.provider === 'workers-ai') {
    if (!env.AI) {
      throw new Error('Workers AI 绑定未配置（wrangler.toml 需要 [ai] binding = "AI"）');
    }
    // older models return { response }, newer ones an OpenAI-style chat.completion
    const res = (await env.AI.run(
      resolvedModel(config) as Parameters<Ai['run']>[0],
      { messages, max_tokens: 240 },
    )) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
    const raw = res.choices?.[0]?.message?.content ?? res.response ?? '';
    text = typeof raw === 'string' ? raw : '';
  } else {
    const base = (config.base_url || DEFAULT_OPENAI_BASE).replace(/\/+$/, '');
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
      },
      body: JSON.stringify({
        model: resolvedModel(config),
        messages,
        max_tokens: 240,
        temperature: 0,
      }),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      throw new Error(`上游接口返回 HTTP ${resp.status}：${detail}`);
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    text = data.choices?.[0]?.message?.content ?? '';
  }

  return parseAiAnalysisResponse(text);
}

// Silent wrapper for the mail pipeline: AI analysis must never break routing.
export async function analyzeEmailWithAI(
  env: Env,
  config: AiConfig,
  subject: string,
  body: string,
): Promise<EmailAiAnalysis> {
  try {
    return await runAiAnalysis(env, config, subject, body);
  } catch (e) {
    console.error('AI analysis failed:', e);
    return { code: null, summary: null };
  }
}

export async function extractCodeWithAI(
  env: Env,
  config: AiConfig,
  subject: string,
  body: string,
): Promise<string | null> {
  const result = await analyzeEmailWithAI(env, config, subject, body);
  return result.code;
}
