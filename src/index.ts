import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { ClientUpdates } from "./client-updates.js";
import { JsonServer } from "./json.js";
import type { EventName, EventRequest } from "./protocol.js";
import { isEventName, isReplayableEventName } from "./protocol.js";
import { ReplayStore, validateOverlayEvent } from "./replay.js";
import { SseServer } from "./sse.js";

// Load the project-local file for both `npm run dev` (src/) and `npm start` (dist/).
// Node preserves environment variables already supplied by the shell.
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const controlApiKey = process.env.TVS_REMOTE_MANAGEMENT_CONTROL_KEY;
const clientApiKey = process.env.TVS_REMOTE_MANAGEMENT_CLIENT_KEY;
const hostname = process.env.TVS_REMOTE_MANAGEMENT_HOST || "127.0.0.1";
const replayStore = new ReplayStore();

let replayOnConnect = false;

const sseServer = new SseServer({
  clientApiKey: clientApiKey,
  replayOnConnect: () => replayOnConnect,
  replay: (clientId, send) => replayStore.replayTo(clientId, send),
  onClientsChanged: publishClients,
});
const jsonServer = new JsonServer({
  clientApiKey: clientApiKey,
  projectState: (clientId) => replayStore.projectJsonState(clientId),
  onClientsChanged: publishClients,
});
const clientUpdates = new ClientUpdates(() => ({ clients: listClients() }));
const app = new Hono();

// JSON clients expire from the recent-client list after five minutes. This heartbeat also
// keeps long-lived control-panel streams current if an intermediate connection event is lost.
setInterval(() => clientUpdates.publish(), 30_000).unref();

app.use(
  "*",
  cors({
    origin: (origin) =>
      !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ? origin || "*"
        : null,
  }),
);

app.use("/api/*", requireControlApiKey);
app.use("/remote/*", requireControlApiKey);
app.use("/channel-change", requireControlApiKey);

app.get("/sse", (c) => sseServer.connect(c));
app.get("/state.json", (c) => jsonServer.poll(c));
app.get("/api/client-events", (c) => clientUpdates.connect(c));

// A small authenticated probe lets the control panel decide whether to show its login.
// The /api/* middleware returns 401 when a required key is absent or incorrect.
app.get("/api/auth-check", (c) => c.json({ controlKeyRequired: Boolean(controlApiKey) }));

app.get("/api/clients", (c) => c.json({ clients: listClients() }));

/** Include both live SSE connections and JSON clients seen within the last five minutes. */
function listClients() {
  const jsonClientIds = jsonServer.recentClientIds();
  const clientIds = [...new Set([...sseServer.clientIds(), ...jsonClientIds])];

  return clientIds
    .map((clientId) => ({
      clientId,
      connections: sseServer.connectionCount(clientId),
      transports: [
        ...(sseServer.hasClient(clientId) ? ["sse"] : []),
        ...(jsonServer.hasClient(clientId) ? ["json"] : []),
      ],
      lastJsonPoll: jsonServer.lastPoll(clientId),
    }))
    .sort((left, right) => left.clientId.localeCompare(right.clientId));
}

/** Fan out the complete list so the page does not poll for connection changes. */
function publishClients(): void {
  clientUpdates.publish();
}

app.get("/api/settings", (c) => c.json({ replayOnConnect }));

app.get("/api/overlay-state", (c) => {
  const requestedClientIds = c.req.queries("clientId");
  const clientIds = resolveTargetClientIds(requestedClientIds);
  return c.json({
    clients: clientIds.map((clientId) => ({
      clientId,
      overlays: (replayStore.projectJsonState(clientId).overlays ?? []).map(
        ({ channelNumber, slotNumber, mixBlendMode }) => ({ channelNumber, slotNumber, mixBlendMode }),
      ),
    })),
  });
});

app.post("/api/settings", async (c) => {
  const body = await c.req.json<{ replayOnConnect?: unknown }>();
  if (typeof body.replayOnConnect !== "boolean") {
    return c.json({ error: "replayOnConnect must be a boolean." }, 400);
  }

  replayOnConnect = body.replayOnConnect;
  return c.json({ replayOnConnect });
});

app.post("/api/replay", async (c) => {
  const body = await readEventRequest(c);
  if (body instanceof Response) {
    return body;
  }

  const targetClientIds = resolveTargetClientIds(body.clientIds);
  const delivered = sseServer.replay(targetClientIds);
  return c.json({ status: "ok", clients: targetClientIds, connections: delivered });
});

app.post("/api/events/:eventName", async (c) => {
  const eventName = c.req.param("eventName");
  if (!isEventName(eventName)) {
    return c.json({ error: `Unsupported event name: ${eventName}` }, 400);
  }

  const request = await readEventRequest(c, true);
  if (request instanceof Response) {
    return request;
  }

  try {
    return c.json(dispatchEvent(eventName, request));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid event." }, 400);
  }
});

// These direct endpoints remain useful as deliberately simple integration examples.
app.post("/remote/:command", (c) =>
  c.json(dispatchEvent("remote", { payload: { command: c.req.param("command") } })),
);

app.post("/channel-change", async (c) =>
  c.json(dispatchEvent("channel-change", { payload: await c.req.json() })),
);

// Serve the installed Shell.css assets locally so the demos work without a CDN connection.
app.use(
  "/shell-css/*",
  serveStatic({
    root: "./node_modules/shell-css/dist",
    rewriteRequestPath: (path) => path.replace(/^\/shell-css/, ""),
  }),
);
app.use("/*", serveStatic({ root: "./static" }));

serve(
  { fetch: app.fetch, hostname, port: 3991 },
  (info) => {
    console.log(`Server is running on http://${hostname}:${info.port}`);
    if (controlApiKey) {
      console.log("Control API-key checking is enabled by TVS_REMOTE_MANAGEMENT_CONTROL_KEY.");
    }
    if (clientApiKey) {
      console.log("Client connection API-key checking is enabled by TVS_REMOTE_MANAGEMENT_CLIENT_KEY.");
    }
  },
);

/** Protects control endpoints with the server's optional header-based API key. */
async function requireControlApiKey(c: Context, next: () => Promise<void>) {
  // Native EventSource cannot set headers. Only this read-only stream accepts its key in
  // the query string; all other control endpoints continue requiring the header.
  const key = c.req.header("x-api-key")
    ?? (c.req.path === "/api/client-events" ? c.req.query("key") : undefined);
  if (controlApiKey && key !== controlApiKey) {
    return c.json({ error: "Invalid control API key." }, 401);
  }

  await next();
}

/** Delivers one event to its resolved SSE targets and optionally remembers declarative state. */
function dispatchEvent(eventName: EventName, request: EventRequest) {
  if (eventName.startsWith("overlay")) {
    validateOverlayEvent(eventName as Extract<EventName, `overlay${string}`>, request.payload);
  }
  const targetClientIds = resolveTargetClientIds(request.clientIds);
  const shouldRemember = isReplayableEventName(eventName) && request.remember !== false;

  if (shouldRemember) {
    replayStore.remember(eventName, request.payload, request.clientIds);
  }

  const delivered = sseServer.send(eventName, request.payload, targetClientIds);

  console.log(
    `Sent ${eventName} to ${request.clientIds?.length ? request.clientIds.join(", ") : "all clients"}`,
  );

  return {
    status: "ok",
    eventName,
    clients: targetClientIds,
    connections: delivered,
    remembered: shouldRemember,
  };
}

/** Resolves an explicit target list or broadcasts to every currently known SSE and JSON client. */
function resolveTargetClientIds(requestedClientIds?: string[]): string[] {
  if (!requestedClientIds || requestedClientIds.length === 0) {
    return [...new Set([...sseServer.clientIds(), ...jsonServer.recentClientIds()])];
  }

  return [...new Set(requestedClientIds.map((id) => id.trim()).filter(Boolean))];
}

/** Parses and validates the common JSON body accepted by the control API's event endpoints. */
async function readEventRequest(c: Context, requirePayload = false): Promise<EventRequest | Response> {
  try {
    const value = await c.req.json<unknown>();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return c.json({ error: "Request body must be an object." }, 400);
    }

    const body = value as Record<string, unknown>;
    if (requirePayload && !Object.prototype.hasOwnProperty.call(body, "payload")) {
      return c.json({ error: "payload is required." }, 400);
    }
    if (
      body.clientIds !== undefined
      && (!Array.isArray(body.clientIds)
        || !body.clientIds.every((id) => typeof id === "string"))
    ) {
      return c.json({ error: "clientIds must be an array of strings." }, 400);
    }

    return {
      clientIds: body.clientIds as string[] | undefined,
      payload: body.payload,
      remember: typeof body.remember === "boolean" ? body.remember : undefined,
    };
  } catch {
    return c.json({ error: "Request body must contain valid JSON." }, 400);
  }
}
