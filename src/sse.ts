import { createResponse, type Session } from "better-sse";
import type { Context } from "hono";
import { readClientId, rejectInvalidClientApiKey } from "./client-request.js";
import type { EventName } from "./protocol.js";
import type { ReplayEventSink } from "./replay.js";

type ClientSession = Session<{ clientId: string }>;

/** Application hooks and security settings supplied to the SSE adapter. */
interface SseServerOptions {
  clientApiKey?: string;
  replayOnConnect: () => boolean;
  replay: (clientId: string, send: ReplayEventSink) => void;
  onClientsChanged?: () => void;
}

/** Owns SSE connections and delivery. Remembering state is intentionally delegated. */
export class SseServer {
  readonly #sessionsByClientId = new Map<string, Set<ClientSession>>();

  /** Creates an SSE adapter with optional state-replay hooks supplied by the application. */
  constructor(private readonly options: SseServerOptions) {}

  /** Validates and opens an EventSource session, optionally replaying state after connection. */
  connect(c: Context): Response {
    const clientId = readClientId(c);
    if (clientId instanceof Response) {
      return clientId;
    }

    const apiKeyError = rejectInvalidClientApiKey(c, this.options.clientApiKey);
    if (apiKeyError) {
      return apiKeyError;
    }

    return createResponse(c.req.raw, (untypedSession) => {
      const session = untypedSession as ClientSession;
      session.state.clientId = clientId;
      this.#registerSession(clientId, session);
      session.push({ clientId, replayOnConnect: this.options.replayOnConnect() }, "connected");

      if (this.options.replayOnConnect()) {
        this.options.replay(clientId, (eventName, payload) => session.push(payload, eventName));
      }
    });
  }

  /** Returns the IDs that currently have at least one open SSE connection. */
  clientIds(): string[] {
    return [...this.#sessionsByClientId.keys()];
  }

  /** Reports whether a client currently has an open SSE connection. */
  hasClient(clientId: string): boolean {
    return this.#sessionsByClientId.has(clientId);
  }

  /** Counts the open tabs or devices connected with a particular client ID. */
  connectionCount(clientId: string): number {
    return this.#sessionsByClientId.get(clientId)?.size ?? 0;
  }

  /** Pushes one named event to every open connection for the supplied client IDs. */
  send(eventName: EventName, payload: unknown, clientIds: string[]): number {
    let delivered = 0;
    for (const clientId of clientIds) {
      for (const session of this.#sessionsByClientId.get(clientId) ?? []) {
        session.push(payload, eventName);
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Invokes the configured replay source for every open connection of the supplied clients. */
  replay(clientIds: string[]): number {
    let delivered = 0;
    for (const clientId of clientIds) {
      for (const session of this.#sessionsByClientId.get(clientId) ?? []) {
        this.options.replay(clientId, (eventName, payload) => session.push(payload, eventName));
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Adds a session to the client registry and removes it again when disconnected. */
  #registerSession(clientId: string, session: ClientSession): void {
    const sessions = this.#sessionsByClientId.get(clientId) ?? new Set<ClientSession>();
    sessions.add(session);
    this.#sessionsByClientId.set(clientId, sessions);
    console.log(`Client connected: ${clientId} (${sessions.size} connection(s))`);
    this.options.onClientsChanged?.();

    session.once("disconnected", () => {
      sessions.delete(session);
      if (sessions.size === 0) {
        this.#sessionsByClientId.delete(clientId);
      }
      console.log(`Client disconnected: ${clientId}`);
      this.options.onClientsChanged?.();
    });
  }
}
