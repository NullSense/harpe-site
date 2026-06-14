/**
 * streamArt — browser helper for the /api/art-stream SSE endpoint.
 *
 * Opens an EventSource on /api/art-stream?q=<encoded>, dispatches each
 * arriving SSE message to the appropriate handler, and returns a cancel
 * function that closes the connection.
 *
 * Usage:
 *   const cancel = streamArt('rodin thinker', {
 *     onBatch: (source, items) => { ... },
 *     onError: (source, error) => { ... },
 *     onDone:  ({ analyzeEnabled }) => { ... },
 *   });
 *   // later: cancel();
 */

export function streamArt(
  q: string,
  handlers: {
    onBatch: (source: string, items: unknown[]) => void;
    onError?: (source: string, error: string) => void;
    onDone?: (info: { analyzeEnabled: boolean }) => void;
  },
): () => void {
  const url = `/api/art-stream?q=${encodeURIComponent(q)}`;
  const es = new EventSource(url);

  es.onmessage = (event: MessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      // Malformed JSON — ignore and keep listening.
      return;
    }

    if (data.done === true) {
      // Final sentinel from the server.
      es.close();
      handlers.onDone?.({
        analyzeEnabled: Boolean(data.analyzeEnabled),
      });
      return;
    }

    const source = typeof data.source === 'string' ? data.source : '';

    if (typeof data.error === 'string') {
      handlers.onError?.(source, data.error);
      return;
    }

    if (Array.isArray(data.items)) {
      handlers.onBatch(source, data.items as unknown[]);
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects on transient errors; close it explicitly
    // so we don't retry on a completed stream (server closed the connection).
    es.close();
  };

  // Return an abort function so callers can cancel mid-stream (e.g. new query).
  return () => {
    es.close();
  };
}
