import type { Context } from "hono";
import { readClientId, rejectInvalidClientApiKey } from "./client-request.js";
import type { JsonStateDocument } from "./protocol.js";

/** Dependencies supplied by the application when constructing the JSON adapter. */
interface JsonServerOptions {
  clientApiKey?: string;
  projectState: (clientId: string) => JsonStateDocument;
  onClientsChanged?: () => void;
}

/** Serves declarative snapshots and tracks clients that have polled recently. */
export class JsonServer {
  readonly #clientsLastSeen = new Map<string, number>();

  /** Creates a JSON adapter backed by the application's current-state projection. */
  constructor(private readonly options: JsonServerOptions) {}

  /** Validates a polling request, records the client, and returns its current state snapshot. */
  poll(c: Context): Response {
    const clientId = readClientId(c);
    if (clientId instanceof Response) {
      return clientId;
    }

    const apiKeyError = rejectInvalidClientApiKey(c, this.options.clientApiKey);
    if (apiKeyError) {
      return apiKeyError;
    }

    const isNewClient = !this.#clientsLastSeen.has(clientId);
    this.#clientsLastSeen.set(clientId, Date.now());
    if (isNewClient) this.options.onClientsChanged?.();
    c.header("Cache-Control", "no-store");
    return c.json(withNamedLayouts(this.options.projectState(clientId)));
  }

  /** Returns clients seen within five minutes and prunes older entries from memory. */
  recentClientIds(now = Date.now()): string[] {
    const cutoff = now - 5 * 60_000;
    for (const [clientId, lastSeen] of this.#clientsLastSeen) {
      if (lastSeen < cutoff) {
        this.#clientsLastSeen.delete(clientId);
      }
    }
    return [...this.#clientsLastSeen.keys()];
  }

  /** Reports whether a client remains in the recent-poll registry. */
  hasClient(clientId: string): boolean {
    return this.#clientsLastSeen.has(clientId);
  }

  /** Returns the client's latest poll time as an ISO timestamp for the control panel. */
  lastPoll(clientId: string): string | undefined {
    const lastSeen = this.#clientsLastSeen.get(clientId);
    return lastSeen === undefined ? undefined : new Date(lastSeen).toISOString();
  }
}

/** Reuse repeated inline layouts by name in JSON snapshots; SSE replay stays self-contained. */
export function withNamedLayouts(state: JsonStateDocument): JsonStateDocument {
  const serialized = (state.overlays ?? []).map((overlay) => JSON.stringify(overlay.layout));
  const counts = new Map<string, number>();
  for (const layout of serialized) {
    if (layout !== undefined) counts.set(layout, (counts.get(layout) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  const layouts: Record<string, Record<string, unknown>> = {};
  const overlays = (state.overlays ?? []).map((overlay, index) => {
    const layout = serialized[index];
    if (layout === undefined || (counts.get(layout) ?? 0) < 2) return overlay;
    let name = names.get(layout);
    if (!name) {
      name = `layout-${names.size + 1}`;
      names.set(layout, name);
      layouts[name] = overlay.layout as Record<string, unknown>;
    }
    const { layout: _layout, ...placement } = overlay;
    return { ...placement, layoutRef: name };
  });
  return {
    ...state,
    ...(Object.keys(layouts).length ? { layouts } : {}),
    overlays,
  };
}
