import type { AiConfig, Env } from '../types';

const SYSTEM_PROMPT =
  'You extract verification codes (OTP / one-time passcodes) from emails. ' +
  'Reply with ONLY the code itself (letters/digits, no punctuation, no explanation). ' +
  'If the email contains no verification code, reply with exactly: NONE';

const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

function resolvedModel(config: AiConfig): string {
  if (config.provider === 'workers-ai') return config.model || DEFAULT_WORKERS_AI_MODEL;
  if (config.provider === 'openai') return config.model || DEFAULT_OPENAI_MODEL;
  return '';
}

// Core extraction. Throws on provider/network failure so callers can choose
// whether to surface the error or continue without a detected code.
async function runAiExtraction(
  env: Env,
  config: AiConfig,
  subject: string,
  body: string,
): Promise<string | null> {
  if (config.provider === 'none') return null;

  const content = `Subject: ${subject}\n\n${body.slice(0, 4000)}`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
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
      { messages, max_tokens: 20 },
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
        max_tokens: 20,
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

  const answer = text.trim();
  if (!answer || /^none\b/i.test(answer)) return null;

  // keep only something that actually looks like a code
  const m = answer.match(/[A-Z0-9][A-Z0-9-]{3,11}/i);
  return m ? m[0] : null;
}

// Silent wrapper for the mail pipeline: AI extraction must never break routing.
export async function extractCodeWithAI(
  env: Env,
  config: AiConfig,
  subject: string,
  body: string,
): Promise<string | null> {
  try {
    return await runAiExtraction(env, config, subject, body);
  } catch (e) {
    console.error('AI extraction failed:', e);
    return null;
  }
}
