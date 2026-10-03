import type {Answers, DeciderBackend, Decision, Entry, Questions} from './types.js';

const base = () => process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai';
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function errorMessage(body: any, status: number): string {
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.message === 'string') return body.message;
  if (typeof body?.detail === 'string') return body.detail;
  return `HTTP ${status}`;
}

async function request(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8000): Promise<any> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, {
        method,
        headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = new JevError(`Jev unreachable: ${(err as Error).message}`);
      continue;
    }
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.ok) return parsed;
    lastErr = new JevError(`Jev: ${errorMessage(parsed, res.status)}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
  }
  throw lastErr ?? new JevError('Jev request failed');
}

/** Validate a key cheaply (GET /v1/models). */
export async function checkJevKey(apiKey: string): Promise<string[]> {
  const models = await request(apiKey, 'GET', '/v1/models', undefined, 10_000);
  // Response shape: {models: [{name, description, release_date}]} (older/SDK: a bare array).
  const list = Array.isArray(models) ? models : models?.models ?? models?.data ?? [];
  return list.map((m: any) => m.name ?? String(m));
}

export function jevBackend(apiKey: string, model: string): DeciderBackend {
  return {
    name: `Jev (${model})`,
    async ask(state: Entry, questions: Questions): Promise<Decision> {
      const res = await request(apiKey, 'POST', '/v1/systemone', {state, questions, model});
      if (!res?.answers) throw new JevError('Jev: response had no answers');
      return {answers: res.answers as Answers, backend: 'jev', inputTokens: res.usage?.input_tokens};
    },
  };
}
