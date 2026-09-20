import { createResponse, type Session } from "better-sse";
import type { Context } from "hono";

/** Pushes the complete control-panel client list, not TVS remote-management commands. */
export class ClientUpdates {
  readonly #sessions = new Set<Session>();

  constructor(private readonly snapshot: () => unknown) {}

  /** Send the current list immediately; EventSource reconnects and receives a fresh list. */
  connect(c: Context): Response {
    c.header("Cache-Control", "no-store");
    return createResponse(c.req.raw, (session) => {
      this.#sessions.add(session);
      session.push(this.snapshot(), "clients");
      session.once("disconnected", () => this.#sessions.delete(session));
    });
  }

  /** Broadcast a fresh list when TVS connections or known JSON clients change. */
  publish(): void {
    if (this.#sessions.size === 0) return;
    const clients = this.snapshot();
    for (const session of this.#sessions) session.push(clients, "clients");
  }
}
