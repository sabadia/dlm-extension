import { redactText } from '../log/redact';

/** What the daemon sends for an error (RFC 9457 problem details), reduced to what the extension uses. */
export interface ProblemBody {
  status?: number;
  code?: string;
  title?: string;
  detail?: string;
}

/**
 * The daemon refused or failed a request. `code` is the stable machine-readable code (`task.not_found`,
 * `rate_limited`, …); the message has passed through the redactor, so it is safe to show and to log.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** Seconds to wait, from `Retry-After`, when the daemon is rate limiting. */
    readonly retryAfter?: number,
  ) {
    super(redactText(message));
    this.name = 'ApiError';
  }

  /** The token was refused: it is wrong or was revoked. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** The daemon could not be reached at all (not running, wrong address, offline, timed out). */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(redactText(message));
    this.name = 'NetworkError';
  }
}

export async function problemFrom(res: Response): Promise<ApiError> {
  let body: ProblemBody = {};
  try {
    body = (await res.json()) as ProblemBody;
  } catch {
    // not JSON: the status line has to do
  }
  const retry = Number(res.headers.get('Retry-After'));
  const message = body.detail ?? body.title ?? `HTTP ${res.status}`;
  return new ApiError(
    res.status,
    body.code,
    message,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}
