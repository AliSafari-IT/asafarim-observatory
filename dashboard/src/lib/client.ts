export interface Repository {
  name: string;
  path: string;
  branch: string;
  detached: boolean;
  changed_files: number;
  error?: string;
}

export interface Snapshot {
  schema_version: number;
  root: string;
  scanned_at: string;
  repositories: Repository[];
}

export interface RepositorySummary {
  name: string;
  status: string;
  observations: number;
  failed_observations: number;
  observed_branch_switches: number;
  observed_count_changes: number;
  peak_changed_files: number | null;
  latest_changed_files: number | null;
  latest_error: string | null;
}

export interface Analysis {
  schema_version: number;
  root: string;
  snapshot_count: number;
  period_start: string;
  period_end: string;
  sources: string[];
  repositories: RepositorySummary[];
}

export interface AISummary {
  schema_version: number;
  provider: string;
  model: string;
  generated_at: string;
  period_start: string;
  period_end: string;
  snapshot_count: number;
  headline: string;
  findings: { text: string; evidence_ids: string[] }[];
  evidence: (Omit<RepositorySummary, 'latest_error'> & { id: string })[];
  sources: string[];
}

export interface AISummaryState {
  configured: boolean;
  summary: AISummary | null;
}

// This request is deliberately separate from readJSON: paid POSTs are never retried.
export async function generateSummary(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  csrf = ''
): Promise<AISummaryState> {
  const response = await fetcher('/api/summary', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-Observatory-Request': 'generate-summary',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {})
    },
    body: '{}'
  });
  const body = await response.json();
  if (!response.ok)
    throw new APIError(response.status, body.error?.message ?? 'Summary generation failed.');
  return body as AISummaryState;
}

export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readJSON<T>(
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  allowRetry = true
): Promise<T> {
  const response = await fetcher(path, { signal, cache: 'no-store' });
  const retryAfter = response.headers.get('Retry-After');
  if (response.status === 503 && allowRetry && retryAfter !== null && /^[0-2]$/.test(retryAfter)) {
    await pause(Number(retryAfter) * 1000, signal);
    return readJSON<T>(path, signal, fetcher, false);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      /* A proxy failure may return plain text. */
    }
    throw new APIError(response.status, message);
  }
  return response.json() as Promise<T>;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function filterRepositories(
  repositories: Repository[],
  search: string,
  status: string
): Repository[] {
  const query = search.trim().toLowerCase();
  return repositories.filter((repo) => {
    const matchesText = `${repo.name} ${repo.branch}`.toLowerCase().includes(query);
    const matchesStatus =
      status === 'all' ||
      (status === 'changed' && !repo.error && repo.changed_files > 0) ||
      (status === 'clean' && !repo.error && repo.changed_files === 0) ||
      (status === 'unavailable' && Boolean(repo.error));
    return matchesText && matchesStatus;
  });
}

export function statusOf(repo: Repository): string {
  return repo.error ? 'Unavailable' : repo.changed_files > 0 ? 'Uncommitted' : 'Clean';
}
