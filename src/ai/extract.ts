import { getAiModel } from "../config";

export interface ExtractedSignal {
  code?: string;
  service?: string;
  confidence?: number;
  summary?: string;
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
    return parsed;
  } catch {
    return undefined;
  }
}

export async function extractSignalFromMail(
  ai: Ai,
  modelEnv: { AI_MODEL_NAME?: string },
  mailText: string,
  timeoutMs: number
): Promise<ExtractedSignal | undefined> {
  const prompt = [
    "You are an assistant that extracts verification data from emails.",
    "Return strict JSON with keys: code, service, confidence, summary.",
    "If no code is present, set code to empty string and confidence to 0.",
    "",
    "Email text:",
    mailText.slice(0, 6000)
  ].join("\n");

  const model = getAiModel(modelEnv as never);
  const result = (await withTimeout(
    ai.run(model as keyof AiModels, {
      prompt
    }),
    timeoutMs
  )) as AiRunResult;

  if (!result?.response) return undefined;
  return parseJsonResult(result.response);
}
