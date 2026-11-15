import type { FitsInspectResponse, SpherexObservation } from '../types/spherex.ts';

export type ObservationPrepStatus =
  | 'pending'
  | 'loading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'timed-out';

export interface ObservationPrepRecord {
  id: string;
  obsId: string;
  dateDisplay: string;
  bandpass: string;
  status: ObservationPrepStatus;
  error?: string;
  errorCode?: string;
  attempts: number;
}

export const CLIENT_PER_OBS_TIMEOUT_MS = 30_000;

export function deduplicateChronological(observations: SpherexObservation[]): SpherexObservation[] {
  const seen = new Set<string>();
  const unique: SpherexObservation[] = [];
  for (const obs of observations) {
    if (!seen.has(obs.id)) {
      seen.add(obs.id);
      unique.push(obs);
    }
  }
  return unique.sort((a, b) => {
    const dt = a.tMinMjd - b.tMinMjd;
    if (Math.abs(dt) > 1e-9) return dt;
    const dc = (a.spectralChannel ?? 0) - (b.spectralChannel ?? 0);
    if (dc !== 0) return dc;
    return (a.emCenterUm ?? 0) - (b.emCenterUm ?? 0);
  });
}

export function getReadyObservations(
  observations: SpherexObservation[],
  prepMap: Record<string, ObservationPrepRecord>,
  cacheMap: Record<string, FitsInspectResponse>,
  keyFn: (obsId: string) => string
): SpherexObservation[] {
  return observations.filter((obs) => {
    const rec = prepMap[obs.id];
    const hasImage = Boolean(cacheMap[keyFn(obs.id)]?.pngDataUrl);
    return hasImage && (!rec || rec.status === 'ready');
  });
}

export interface PrepQueueResult {
  readyIds: string[];
  unavailable: ObservationPrepRecord[];
  aborted: boolean;
}

export async function runObservationPrepQueue(params: {
  observations: SpherexObservation[];
  isAlreadyCached: (obs: SpherexObservation) => boolean;
  prepareOne: (
    obs: SpherexObservation,
    onStage: (stage: 'loading' | 'processing') => void,
    signal: AbortSignal
  ) => Promise<{ ok: true } | { ok: false; status: 'failed' | 'timed-out'; error: string; errorCode?: string; retryable?: boolean }>;
  onRecordUpdate: (record: ObservationPrepRecord) => void;
  signal: AbortSignal;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<PrepQueueResult> {
  const {
    observations,
    isAlreadyCached,
    prepareOne,
    onRecordUpdate,
    signal,
    concurrency = 3,
    timeoutMs = CLIENT_PER_OBS_TIMEOUT_MS,
  } = params;

  const readyIds: string[] = [];
  const unavailable: ObservationPrepRecord[] = [];
  const queue: SpherexObservation[] = [];

  for (const obs of observations) {
    if (isAlreadyCached(obs)) {
      readyIds.push(obs.id);
      onRecordUpdate({
        id: obs.id,
        obsId: obs.obsId,
        dateDisplay: obs.obsDateDisplay,
        bandpass: obs.bandpassName,
        status: 'ready',
        attempts: 0,
      });
    } else {
      queue.push(obs);
      onRecordUpdate({
        id: obs.id,
        obsId: obs.obsId,
        dateDisplay: obs.obsDateDisplay,
        bandpass: obs.bandpassName,
        status: 'pending',
        attempts: 0,
      });
    }
  }

  let cursor = 0;

  async function worker() {
    while (cursor < queue.length && !signal.aborted) {
      const obs = queue[cursor++];
      let finalRec: ObservationPrepRecord | null = null;
      const deadline = Date.now() + timeoutMs;

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal.aborted) return;

        const remaining = deadline - Date.now();
        if (remaining <= 200) {
          finalRec = {
            id: obs.id,
            obsId: obs.obsId,
            dateDisplay: obs.obsDateDisplay,
            bandpass: obs.bandpassName,
            status: 'timed-out',
            error: 'Observation preparation exceeded the 30-second timeout.',
            errorCode: 'TIMEOUT',
            attempts: attempt - 1,
          };
          break;
        }

        const obsController = new AbortController();
        const onParentAbort = () => obsController.abort();
        signal.addEventListener('abort', onParentAbort, { once: true });
        const timeoutTimer = setTimeout(() => obsController.abort('timeout'), remaining);

        onRecordUpdate({
          id: obs.id,
          obsId: obs.obsId,
          dateDisplay: obs.obsDateDisplay,
          bandpass: obs.bandpassName,
          status: 'loading',
          attempts: attempt,
        });

        try {
          const outcome = await prepareOne(
            obs,
            (stage) => {
              if (!signal.aborted && !obsController.signal.aborted) {
                onRecordUpdate({
                  id: obs.id,
                  obsId: obs.obsId,
                  dateDisplay: obs.obsDateDisplay,
                  bandpass: obs.bandpassName,
                  status: stage,
                  attempts: attempt,
                });
              }
            },
            obsController.signal
          );

          clearTimeout(timeoutTimer);
          signal.removeEventListener('abort', onParentAbort);

          if (signal.aborted) return;

          if (outcome.ok) {
            finalRec = {
              id: obs.id,
              obsId: obs.obsId,
              dateDisplay: obs.obsDateDisplay,
              bandpass: obs.bandpassName,
              status: 'ready',
              attempts: attempt,
            };
            break;
          }

          const isTimeout =
            outcome.status === 'timed-out' || obsController.signal.reason === 'timeout';
          finalRec = {
            id: obs.id,
            obsId: obs.obsId,
            dateDisplay: obs.obsDateDisplay,
            bandpass: obs.bandpassName,
            status: isTimeout ? 'timed-out' : 'failed',
            error: outcome.error,
            errorCode: outcome.errorCode,
            attempts: attempt,
          };

          if (outcome.retryable && !isTimeout && attempt < 2 && deadline - Date.now() > 1500) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          break;
        } catch (err) {
          clearTimeout(timeoutTimer);
          signal.removeEventListener('abort', onParentAbort);

          if (signal.aborted) return;

          const isTimeout = obsController.signal.reason === 'timeout';
          finalRec = {
            id: obs.id,
            obsId: obs.obsId,
            dateDisplay: obs.obsDateDisplay,
            bandpass: obs.bandpassName,
            status: isTimeout ? 'timed-out' : 'failed',
            error: isTimeout
              ? 'Observation preparation exceeded the 30-second timeout.'
              : err instanceof Error
                ? err.message
                : 'Unexpected observation preparation error.',
            errorCode: isTimeout ? 'TIMEOUT' : 'HTTP_ERROR',
            attempts: attempt,
          };
          break;
        }
      }

      if (signal.aborted) return;

      if (finalRec) {
        onRecordUpdate(finalRec);
        if (finalRec.status === 'ready') {
          readyIds.push(obs.id);
        } else {
          unavailable.push(finalRec);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker())
  );

  return {
    readyIds,
    unavailable,
    aborted: signal.aborted,
  };
}
