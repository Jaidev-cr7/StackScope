// The live event stream for one run.
//
// The browser's `EventSource` reconnects on its own and sends the last event
// id it saw in the `Last-Event-ID` header, which is exactly the resume
// contract the server implements. So this hook does not have to manage
// reconnection at all - it only has to open the stream and close it when the
// run changes or the component unmounts.
//
// The server sends named events (`event: run.state`), not anonymous messages,
// so every event type in the vocabulary has to be subscribed to explicitly.
import { useEffect, useRef } from 'react';

import { streamUrl } from '../api/client.js';
import { SSE_EVENT_TYPES } from '../constants.js';

export function useRunStream(runId, onEvent) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) return undefined;

    const source = new EventSource(streamUrl(runId), { withCredentials: true });

    const dispatch = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // A frame we cannot parse is not worth crashing the page over.
      }
      handler.current?.({ type: event.type, payload });
    };

    for (const type of SSE_EVENT_TYPES) {
      source.addEventListener(type, dispatch);
    }
    source.onerror = () => {
      // EventSource reconnects by itself; the error event only tells us that
      // the stream is currently down.
      handler.current?.({ type: 'stream.error', payload: null });
    };

    return () => {
      for (const type of SSE_EVENT_TYPES) {
        source.removeEventListener(type, dispatch);
      }
      source.close();
    };
  }, [runId]);
}

export default useRunStream;
