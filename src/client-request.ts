import type { Context } from "hono";

/** Reads and validates the client ID shared by the SSE and JSON query-string contracts. */
export function readClientId(c: Context): string | Response {
  const clientId = c.req.query("clientId")?.trim();
  if (!clientId || clientId.length > 128) {
    return c.text(
      "The clientId query parameter is required and may contain at most 128 characters.",
      400,
    );
  }
  return clientId;
}

/** Returns an HTTP error when the optional client connection API key does not match. */
export function rejectInvalidClientApiKey(
  c: Context,
  clientApiKey: string | undefined,
): Response | undefined {
  if (clientApiKey && c.req.query("key") !== clientApiKey) {
    return c.text("Invalid client API key.", 401);
  }
}
