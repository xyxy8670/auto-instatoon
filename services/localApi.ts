type ApiErrorShape = {
  error?: {
    message?: string;
    code?: string;
    category?: string;
    retryable?: boolean;
    request_id?: string;
  };
};

export type ApiRetryInfo = {
  attempt: number;
  maxAttempts: number;
  requestId: string;
  message: string;
};

export type ApiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  onRetry?: (info: ApiRetryInfo) => void;
};

export class ApiRequestError extends Error {
  status?: number;
  code?: string;
  category?: string;
  retryable?: boolean;
  requestId?: string;

  constructor(message: string, details: Partial<ApiRequestError> = {}) {
    super(message);
    this.name = "ApiRequestError";
    Object.assign(this, details);
  }
}

const DEFAULT_GET_TIMEOUT_MS = 30_000;
const DEFAULT_POST_TIMEOUT_MS = 10 * 60_000;

const createRequestId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) return cryptoApi.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildAbortSignal = (externalSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const onExternalAbort = () => abort(externalSignal?.reason || new Error("Request cancelled."));
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => abort(new Error("Request timed out.")), timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  };
};

const readErrorPayload = async (response: Response): Promise<ApiErrorShape> => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return (await response.json()) as ApiErrorShape;
    } catch {
      // ignore
    }
  }
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (/PayloadTooLargeError|request entity too large/i.test(trimmed)) {
      return {
        error: {
          message: "요청 자료가 너무 커서 로컬 API가 받지 못했어. 더 작은 파일을 쓰거나 LOCAL_API_JSON_LIMIT 값을 올린 뒤 서버를 다시 시작해줘.",
          code: "PAYLOAD_TOO_LARGE",
          category: "payload"
        }
      };
    }
    if (trimmed) return { error: { message: trimmed } };
  } catch {
    // ignore
  }
  return { error: { message: `Request failed (${response.status})` } };
};

const buildHttpError = async (response: Response, requestId: string): Promise<ApiRequestError> => {
  const payload = await readErrorPayload(response);
  const err = payload.error || {};
  return new ApiRequestError(err.message?.trim() || `Request failed (${response.status})`, {
    status: response.status,
    code: err.code,
    category: err.category,
    retryable: err.retryable,
    requestId: err.request_id || response.headers.get("x-request-id") || requestId
  });
};

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.retryable === true) return true;
  if (["timeout", "network", "no_image", "empty_response"].includes(error.category || "")) return true;
  return [408, 429, 500, 502, 503, 504].includes(error.status || 0);
};

const normalizeFetchError = (error: unknown, requestId: string, signal: AbortSignal): ApiRequestError => {
  const message = String((error as any)?.message || error || "").trim();
  if (signal.aborted) {
    const timedOut = /timed out/i.test(message);
    return new ApiRequestError(
      timedOut ? "요청 시간이 너무 길어져 중단했어. 다시 시도하거나 해상도/품질을 낮춰줘." : "요청을 취소했어.",
      {
        code: timedOut ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
        category: timedOut ? "timeout" : "cancelled",
        retryable: timedOut,
        requestId
      }
    );
  }
  return new ApiRequestError(message || "로컬 API에 연결하지 못했어.", {
    code: "NETWORK_ERROR",
    category: "network",
    retryable: true,
    requestId
  });
};

export const getJson = async <T>(url: string, options: ApiRequestOptions = {}): Promise<T> => {
  const requestId = createRequestId();
  const timeout = buildAbortSignal(options.signal, options.timeoutMs ?? DEFAULT_GET_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-Request-Id": requestId },
      signal: timeout.signal
    });
    if (!response.ok) throw await buildHttpError(response, requestId);
    return (await response.json()) as T;
  } catch (e) {
    if (e instanceof ApiRequestError) throw e;
    throw normalizeFetchError(e, requestId, timeout.signal);
  } finally {
    timeout.cleanup();
  }
};

export const postJson = async <T>(url: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> => {
  const maxAttempts = Math.max(1, 1 + Math.max(0, options.retries ?? 0));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestId = createRequestId();
    const timeout = buildAbortSignal(options.signal, options.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId
        },
        body: JSON.stringify(body),
        signal: timeout.signal
      });

      if (!response.ok) throw await buildHttpError(response, requestId);
      return (await response.json()) as T;
    } catch (e) {
      const error = e instanceof ApiRequestError ? e : normalizeFetchError(e, requestId, timeout.signal);
      lastError = error;
      if (options.signal?.aborted || attempt >= maxAttempts || !isRetryableError(error)) throw error;
      options.onRetry?.({
        attempt,
        maxAttempts,
        requestId: error.requestId || requestId,
        message: error.message
      });
      await wait(options.retryDelayMs ?? 1200);
    } finally {
      timeout.cleanup();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed.");
};
