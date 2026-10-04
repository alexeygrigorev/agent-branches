/**
 * Local node:http adapter (facade extraction, 2026-10-03): translates the
 * platform request/response onto the provider-neutral HttpRequest /
 * HttpResponse and serves the SAME routes from the SAME core router as the
 * Cloudflare Worker — proof that the core runs without workerd.
 */

import {
  createServer,
  type NodeRequestLike,
  type NodeResponseLike,
  type NodeServerLike,
} from "node:http";
import type { CoordinatorAccess } from "../core/coordinator.js";
import { handleRoute, type HttpRequest, type RouterServices } from "../core/router.js";

export type { NodeRequestLike, NodeResponseLike, NodeServerLike };

function toHttpRequest(request: NodeRequestLike): HttpRequest {
  // Read the body once; json() is memoized so multiple reads stay safe.
  let bodyPromise: Promise<Uint8Array> | null = null;
  const readBody = (): Promise<Uint8Array> => {
    if (!bodyPromise) {
      bodyPromise = new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        const encoder = new TextEncoder();
        request.on("data", (chunk) => {
          chunks.push(typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk));
        });
        request.on("end", () => {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve(merged);
        });
        request.on("error", reject);
      });
    }
    return bodyPromise;
  };
  const decoder = new TextDecoder();
  return {
    method: request.method ?? "GET",
    path: (request.url ?? "/").split("?")[0],
    header(name) {
      const value = request.headers[name.toLowerCase()];
      if (Array.isArray(value)) {
        return value[0] ?? null;
      }
      return value ?? null;
    },
    async json() {
      const raw = decoder.decode(await readBody());
      if (raw.trim().length === 0) {
        // Worker Request.json() rejects empty bodies the same way.
        throw new SyntaxError("unexpected end of JSON input");
      }
      return JSON.parse(raw) as unknown;
    },
  };
}

function toNodeResponse(
  response: { status: number; body: unknown; headers?: Record<string, string> },
  node: NodeResponseLike,
): void {
  // 204 must not carry a body (matches the Worker adapter).
  const body = response.status === 204 ? "" : JSON.stringify(response.body, null, 2);
  node.writeHead(response.status, { "content-type": "application/json", ...response.headers });
  node.end(body);
}

/**
 * Serve the wire routes from any CoordinatorAccess (usually a
 * CoordinatorCore) over node:http. Used by src/local/main.ts and exercised
 * end-to-end by the node --test suite with in-memory fakes — no workerd.
 */
export function serveCoordinator(services: RouterServices): NodeServerLike {
  return createServer((request, response) => {
    void (async () => {
      try {
        const outcome = await handleRoute(services, toHttpRequest(request));
        toNodeResponse(outcome, response);
      } catch (error) {
        // handleRoute maps everything itself; this guards adapter faults.
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `local runtime fault: ${(error as Error).message}` }, null, 2));
      }
    })();
  });
}

export type { CoordinatorAccess };
