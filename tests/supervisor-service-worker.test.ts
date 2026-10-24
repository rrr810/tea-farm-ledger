import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

type WorkerHarness = {
  cacheNames: () => string[];
  deletedCaches: string[];
  fetchCalls: string[];
  dispatchFetch: (request: Request) => Promise<Response> | undefined;
  dispatchActivate: () => Promise<void>;
};

function requestKey(request: Request | string): string {
  return typeof request === "string" ? request : request.url;
}

function navigationRequest(url: string): Request {
  // Node's Fetch implementation does not allow constructing a Request with
  // browser-only mode "navigate", so model the ServiceWorker request shape.
  return { url, method: "GET", mode: "navigate" } as Request;
}

function loadServiceWorker(options: {
  cached?: Record<string, Record<string, string>>;
  fetchResult?: (request: Request) => Response | Promise<Response>;
  fetchError?: Error;
} = {}): WorkerHarness {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const deletedCaches: string[] = [];
  const fetchCalls: string[] = [];

  for (const [cacheName, entries] of Object.entries(options.cached ?? {})) {
    stores.set(cacheName, new Map(Object.entries(entries).map(([url, body]) => [url, new Response(body)])));
  }

  const cacheStorage = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      return {
        async match(request: Request | string) {
          const response = store!.get(requestKey(request));
          return response?.clone();
        },
        async put(request: Request | string, response: Response) {
          store!.set(requestKey(request), response.clone());
        },
      };
    },
    async match(request: Request | string) {
      for (const store of stores.values()) {
        const response = store.get(requestKey(request));
        if (response) return response.clone();
      }
      return undefined;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      deletedCaches.push(name);
      return stores.delete(name);
    },
  };

  const worker = {
    location: { origin: "https://tea-farm-ledger.vercel.app" },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
  };

  const source = readFileSync(resolve(process.cwd(), "apps/supervisor-pwa/public/sw.js"), "utf8");
  vm.runInNewContext(source, {
    self: worker,
    caches: cacheStorage,
    fetch: async (request: Request) => {
      fetchCalls.push(request.url);
      if (options.fetchError) throw options.fetchError;
      return options.fetchResult ? options.fetchResult(request) : new Response("network");
    },
    URL,
    Response,
    Promise,
  });

  return {
    cacheNames: () => [...stores.keys()],
    deletedCaches,
    fetchCalls,
    dispatchFetch(request: Request) {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")?.({
        request,
        respondWith(value: Promise<Response> | Response) {
          response = Promise.resolve(value);
        },
      });
      return response;
    },
    async dispatchActivate() {
      let completion: Promise<unknown> | undefined;
      listeners.get("activate")?.({
        waitUntil(value: Promise<unknown>) {
          completion = value;
        },
      });
      await completion;
    },
  };
}

describe("supervisor PWA service worker", () => {
  it("uses the network before any cached daily-sheet document", async () => {
    const url = "https://tea-farm-ledger.vercel.app/";
    const worker = loadServiceWorker({
      cached: { "tea-v1": { [url]: "old locked-day page" } },
      fetchResult: () => new Response("fresh next-day page"),
    });

    const response = await worker.dispatchFetch(navigationRequest(url));

    expect(await response?.text()).toBe("fresh next-day page");
    expect(worker.fetchCalls).toEqual([url]);
    expect(worker.cacheNames()).toContain("tea-shell-v2");
  });

  it("falls back to the cached document while offline", async () => {
    const url = "https://tea-farm-ledger.vercel.app/";
    const worker = loadServiceWorker({
      cached: { "tea-shell-v2": { [url]: "offline daily sheet" } },
      fetchError: new Error("offline"),
    });

    const response = await worker.dispatchFetch(navigationRequest(url));

    expect(await response?.text()).toBe("offline daily sheet");
  });

  it("clears the old tea-v1 cache when the new worker activates", async () => {
    const worker = loadServiceWorker({
      cached: {
        "tea-v1": { "https://tea-farm-ledger.vercel.app/": "old" },
        unrelated: { "https://example.test/": "keep" },
      },
    });

    await worker.dispatchActivate();

    expect(worker.deletedCaches).toContain("tea-v1");
    expect(worker.cacheNames()).not.toContain("tea-v1");
    expect(worker.cacheNames()).toContain("unrelated");
  });

  it("does not intercept API requests", () => {
    const worker = loadServiceWorker();

    const response = worker.dispatchFetch(new Request("https://tea-farm-ledger.vercel.app/api/farms"));

    expect(response).toBeUndefined();
    expect(worker.fetchCalls).toEqual([]);
  });
});
