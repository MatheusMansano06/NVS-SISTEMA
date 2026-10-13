import type { ApiErrorBody } from '@nvs/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

/** Cliente HTTP mínimo. A sessão viaja em cookie httpOnly (mesma origem), nunca em JS. */
export async function http<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('Sem conexão com o servidor. Tente novamente.', 0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(
      err?.message ?? 'Algo deu errado. Tente novamente.',
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.details?.fieldErrors ?? {},
    );
  }
  return body as T;
}
