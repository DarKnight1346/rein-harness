const base = () => process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai';
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
export class JevError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
function errorMessage(body, status) {
    if (typeof body?.error === 'string')
        return body.error;
    if (typeof body?.error?.message === 'string')
        return body.error.message;
    if (typeof body?.message === 'string')
        return body.message;
    if (typeof body?.detail === 'string')
        return body.detail;
    return `HTTP ${status}`;
}
async function request(apiKey, method, path, body, timeoutMs = 8000) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt)
            await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        let res;
        try {
            res = await fetch(`${base()}${path}`, {
                method,
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (err) {
            lastErr = new JevError(`Jev unreachable: ${err.message}`);
            continue;
        }
        const text = await res.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        }
        catch {
            parsed = undefined;
        }
        if (res.ok)
            return parsed;
        lastErr = new JevError(`Jev: ${errorMessage(parsed, res.status)}`, res.status);
        if (!RETRY_STATUS.has(res.status))
            break;
    }
    throw lastErr ?? new JevError('Jev request failed');
}
/** Validate a key cheaply (GET /v1/models). */
export async function checkJevKey(apiKey) {
    const models = await request(apiKey, 'GET', '/v1/models', undefined, 10_000);
    // Response shape: {models: [{name, description, release_date}]} (older/SDK: a bare array).
    const list = Array.isArray(models) ? models : models?.models ?? models?.data ?? [];
    return list.map((m) => m.name ?? String(m));
}
export function jevBackend(apiKey, model) {
    return {
        name: `Jev (${model})`,
        async ask(state, questions) {
            const res = await request(apiKey, 'POST', '/v1/systemone', { state, questions, model });
            if (!res?.answers)
                throw new JevError('Jev: response had no answers');
            return { answers: res.answers, backend: 'jev', inputTokens: res.usage?.input_tokens };
        },
    };
}
