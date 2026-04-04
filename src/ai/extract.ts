import { getAiModel } from "../config";

export interface ExtractedSignal {
  codeOrLink?: string;
  service?: string;
  confidence?: number;
}

interface AiRunResult {
  response?: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AI timeout")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parseJsonResult(text: string): ExtractedSignal | undefined {
  const fenced = text.match(/```json\s*([\s\S]+?)\s*```/i)?.[1];
  const payload = fenced ?? text;
  try {
    const parsed = JSON.parse(payload) as ExtractedSignal;
    if (!parsed.codeOrLink) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

const SYSTEM_PROMPT = `You extract verification codes or login/action links from emails.
Return ONLY a JSON object, no markdown fences, no explanation.

Rules:
- If the email contains a verification/OTP code, set codeOrLink to the code string.
- If no code but contains a login, verification, or one-time action link, set codeOrLink to the full URL.
- If both exist, prefer the code.
- If neither exists, return {"codeOrLink":"","service":"","confidence":0}.
- service: the sender's service name (e.g. "GitHub", "OpenAI", "Google").
- confidence: 0.0 to 1.0, how confident you are that codeOrLink is correct.

Output schema: {"codeOrLink":"string","service":"string","confidence":number}`;

export async function extractSignalFromMail(
  ai: Ai,
  modelEnv: { AI_MODEL_NAME?: string },
  mailText: string,
  timeoutMs: number
): Promise<ExtractedSignal | undefined> {
  const model = getAiModel(modelEnv as never);
  const result = (await withTimeout(
    ai.run(model as keyof AiModels, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: mailText.slice(0, 6000) }
      ]
    }),
    timeoutMs
  )) as AiRunResult;

  const response = result?.response;
  if (!response || typeof response !== "string") return undefined;
  return parseJsonResult(response);
}
