import type {
  Earthquake,
  FeedItem,
  Flight,
  Vessel,
  NewsSource,
  ProviderStatus,
  MarketAsset
} from "./types";

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 45000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...init,
      signal: controller.signal
    });

    const type = response.headers.get("content-type") || "";
    const text = await response.text();

    if (!type.includes("application/json")) {
      throw new Error(
        `${path}: expected JSON but got ${type || "unknown"} ` +
          `(HTTP ${response.status}). Backend asleep or route missing?`
      );
    }

    let data: any;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${path}: invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(data?.error || `${path}: HTTP ${response.status}`);
    }

    return data as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`${path}: timeout after ${timeoutMs / 1000}s`);
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const get = <T>(path: string) => request<T>(path);

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

export const api = {
  news: () =>
    get<{
      items: FeedItem[];
      status: string;
      sourceStatus: {
        source: string;
        status: string;
        error?: string;
      }[];
    }>("/api/news"),

  events: () =>
    get<{
      items: FeedItem[];
      status: string;
    }>("/api/events"),

  earthquakes: () =>
    get<{
      items: Earthquake[];
      status: string;
    }>("/api/earthquakes"),

  flights: () =>
    get<{
      items: Flight[];
      status: string;
      count: number;
      detail?: string;
    }>("/api/flights"),

  vessels: () =>
    get<{
      items: Vessel[];
      status: string;
      count: number;
      detail?: string;
    }>("/api/vessels"),

  sources: () =>
    get<{
      items: NewsSource[];
    }>("/api/news/sources"),

  addSource: (source: {
    name: string;
    url: string;
    category: string;
  }) =>
    post<{
      ok: boolean;
      source: NewsSource;
    }>("/api/news/sources", source),

  removeSource: (url: string) =>
    post<{
      ok: boolean;
    }>("/api/news/sources/remove", { url }),

  status: () =>
    get<{
      services: Record<string, ProviderStatus>;
    }>("/api/status"),

  markets: () =>
    get<{
      items: MarketAsset[];
      services: Record<string, ProviderStatus>;
    }>("/api/markets")
};
