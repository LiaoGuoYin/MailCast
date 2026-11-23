import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeEmailWithAI, parseAiAnalysisResponse } from '../src/ai/extract';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AI email analysis', () => {
  it('parses standard CODE and SUMMARY responses', () => {
    expect(parseAiAnalysisResponse(
      'CODE: 482913\nSUMMARY: GitHub 登录验证码为 482913，10 分钟内有效。',
    )).toEqual({
      code: '482913',
      summary: 'GitHub 登录验证码为 482913，10 分钟内有效。',
    });

    expect(parseAiAnalysisResponse(
      'CODE: NONE\nSUMMARY: BNESIM 通知您的 eSIM 已就绪，可前往 App 安装激活。',
    )).toEqual({
      code: null,
      summary: 'BNESIM 通知您的 eSIM 已就绪，可前往 App 安装激活。',
    });
  });

  it('tolerates JSON and markdown fenced AI outputs', () => {
    expect(parseAiAnalysisResponse(
      '```json\n{"code": "AB-9012", "summary": "账户安全验证通知。"}\n```',
    )).toEqual({
      code: 'AB-9012',
      summary: '账户安全验证通知。',
    });
  });

  it('cleans HTML and CSS before calling Workers AI and returns code + summary', async () => {
    const run = vi.fn().mockResolvedValue({
      response: 'CODE: NONE\nSUMMARY: BNESIM 提示您的 Japan 5GB eSIM 已准备就绪。',
    });

    const result = await analyzeEmailWithAI(
      { AI: { run } } as never,
      { provider: 'workers-ai', model: '', base_url: '', api_key: '' },
      'Thanks, your eSIM is ready',
      '<html><head><style>body{margin:0;}</style></head><body><p>Your Japan 5GB eSIM is ready.</p></body></html>',
    );

    expect(result).toEqual({
      code: null,
      summary: 'BNESIM 提示您的 Japan 5GB eSIM 已准备就绪。',
    });
    expect(run).toHaveBeenCalledOnce();
    const userPrompt = run.mock.calls[0][1].messages[1].content as string;
    expect(userPrompt).not.toContain('margin:0');
    expect(userPrompt).toContain('Your Japan 5GB eSIM is ready.');
  });

  it('falls back silently when AI provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValue(new Error('AI timeout'));

    const result = await analyzeEmailWithAI(
      { AI: { run } } as never,
      { provider: 'workers-ai', model: '', base_url: '', api_key: '' },
      'Subject',
      'Body',
    );

    expect(result).toEqual({ code: null, summary: null });
  });
});
