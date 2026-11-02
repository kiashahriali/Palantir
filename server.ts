
import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { RSS_SOURCES } from "./sources";
import type { NewsSource } from "./types";
import { startLive, registerLiveRoutes, liveStatus } from "./live";

const app = express();
const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "SHADOWBROKER/2.0"
  }
});

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = Number(process.env.PORT || 8787);
const cache = new Map<string, {
  expires: number;
  data: unknown;
}>();

const CACHE_TTL = 120000;

let customSources: NewsSource[] = [];

async function cached<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const old = cache.get(key);

  if (old && old.expires > Date.now()) {
    return old.data as T;
  }

  const data = await fn();

  cache.set(key, {
    expires: Date.now() + CACHE_TTL,
    data
  });

  return data;
}

function cleanText(value = "") {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as any).cause;
    return `${error.name}: ${error.message}${
      cause ? " | " + String(cause) : ""
    }`;
  }

  return String(error);
}

function isPrivateIPv4(ip: string) {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some(n => n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function validatePublicUrl(value: string) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local")
  ) {
    throw new Error("Private network URLs are not allowed.");
  }

  if (isIP(url.hostname) === 4 && isPrivateIPv4(url.hostname)) {
    throw new Error("Private IP addresses are not allowed.");
  }

  if (isIP(url.hostname) === 6) {
    const ip = url.hostname.toLowerCase();

    if (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe80:")
    ) {
      throw new Error("Private IP addresses are not allowed.");
    }
  }

  return url.toString();
}

function allSources() {
  return [
    ...RSS_SOURCES,
    ...customSources
  ].filter(source => source.enabled);
}

function invalidate(key: string) {
  cache.delete(key);
}

// HEALTH

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "SHADOWBROKER",
    timestamp: new Date().toISOString()
  });
});

// NEWS SOURCE MANAGEMENT

app.get("/api/news/sources", (_req, res) => {
  res.json({
    items: allSources()
  });
});

app.post("/api/news/sources", (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const url = validatePublicUrl(String(req.body.url || ""));
    const category = String(req.body.category || "world");

    const allowedCategories = [
      "world",
      "conflict",
      "protest",
      "technology",
      "finance"
    ];

    if (!name || name.length > 80) {
      return res.status(400).json({
        error: "Source name must contain 1-80 characters."
      });
    }

    if (!allowedCategories.includes(category)) {
      return res.status(400).json({
        error: "Invalid category."
      });
    }

    if (
      [...RSS_SOURCES, ...customSources]
        .some(source => source.url === url)
    ) {
      return res.status(409).json({
        error: "This source already exists."
      });
    }

    const source: NewsSource = {
      name,
      url,
      category: category as NewsSource["category"],
      enabled: true,
      custom: true
    };

    customSources.push(source);
    invalidate("news");

    res.json({
      ok: true,
      source
    });

  } catch (error) {
    res.status(400).json({
      error: errorText(error)
    });
  }
});

app.post("/api/news/sources/remove", (req, res) => {
  const url = String(req.body.url || "");

  customSources = customSources.filter(
    source => source.url !== url
  );

  invalidate("news");

  res.json({ ok: true });
});

// NEWS

app.get("/api/news", async (_req, res) => {
  try {
    const result = await cached("news", async () => {
      const sources = allSources();

      const feeds = await Promise.allSettled(
        sources.map(async source => {
          const feed = await parser.parseURL(source.url);

          const items = (feed.items || [])
            .slice(0, 30)
            .map((item, index) => ({
              id: `${source.name}-${item.guid || item.link || index}`,
              title: cleanText(item.title || "Untitled report"),
              source: source.name,
              url: item.link || "",
              publishedAt: item.isoDate || item.pubDate,
              summary: cleanText(
                item.contentSnippet || item.content || ""
              ),
              category: source.category
            }));

          return {
            source: source.name,
            items
          };
        })
      );

      const items = feeds.flatMap(feed =>
        feed.status === "fulfilled"
          ? feed.value.items
          : []
      );

      const sourceStatus = feeds.map((feed, index) => ({
        source: sources[index].name,
        status: feed.status === "fulfilled"
          ? "online"
          : "offline",
        error: feed.status === "rejected"
          ? errorText(feed.reason)
          : undefined
      }));

      return {
        items: items.sort((a, b) =>
          new Date(b.publishedAt || 0).getTime() -
          new Date(a.publishedAt || 0).getTime()
        ),
        sourceStatus,
        status: items.length > 0
          ? "online"
          : "unavailable"
      };
    });

    res.json(result);

  } catch (error) {
    console.error("NEWS:", error);

    res.status(502).json({
      items: [],
      sourceStatus: [],
      status: "unavailable",
      error: errorText(error)
    });
  }
});

// GDELT

app.get("/api/events", async (_req, res) => {
  try {
    const result = await cached("events", async () => {
      const queries = [
        {
          category: "conflict",
          query: "war OR military attack OR armed conflict"
        },
        {
          category: "protest",
          query: "protest OR demonstration OR civil unrest"
        }
      ];

      const responses = await Promise.allSettled(
        queries.map(async item => {
          const params = new URLSearchParams({
            query: item.query,
            mode: "ArtList",
            format: "json",
            maxrecords: "50",
            sort: "DateDesc"
          });

          const response = await fetch(
            `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
            {
              signal: AbortSignal.timeout(15000)
            }
          );

          if (!response.ok) {
            throw new Error(`GDELT HTTP ${response.status}`);
          }

          const data: any = await response.json();

          return (data.articles || []).map((article: any, index: number) => ({
            id: `${item.category}-${article.url || index}`,
            title: cleanText(article.title || "Untitled event"),
            source: article.domain || "GDELT",
            url: article.url || "",
            publishedAt: article.seendate
              ? `${article.seendate.slice(0, 4)}-${article.seendate.slice(4, 6)}-${article.seendate.slice(6, 8)}T${article.seendate.slice(9, 11)}:${article.seendate.slice(11, 13)}:${article.seendate.slice(13, 15)}Z`
              : undefined,
            summary: "",
            category: item.category
          }));
        })
      );

      return responses.flatMap(result =>
        result.status === "fulfilled"
          ? result.value
          : []
      );
    });

    res.json({
      items: result,
      status: result.length ? "online" : "unavailable"
    });

  } catch (error) {
    console.error("GDELT:", error);

    res.status(502).json({
      items: [],
      status: "unavailable",
      error: errorText(error)
    });
  }
});
// MARKETS

app.get("/api/markets", async (_req, res) => {
  const services: Record<string, {
    status: string;
    detail: string;
  }> = {};

  const items: any[] = [];

  // CRYPTO - BINANCE PUBLIC MARKET DATA

  try {
    const symbols = [
      "BTCUSDT",
      "ETHUSDT",
      "BNBUSDT",
      "SOLUSDT",
      "XRPUSDT",
      "DOGEUSDT",
      "ADAUSDT"
    ];

    const url =
      "https://data-api.binance.vision/api/v3/ticker/24hr";

    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}`);
    }

    const data: any[] = await response.json();

    for (const symbol of symbols) {
      const row = data.find(
        item => item.symbol === symbol
      );

      if (!row) continue;

      items.push({
        symbol,
        name: symbol.replace("USDT", ""),
        category: "crypto",
        price: Number(row.lastPrice),
        change24h: Number(row.priceChangePercent),
        currency: "USDT",
        source: "Binance",
        updatedAt: new Date().toISOString()
      });
    }

    services.Binance = {
      status: "online",
      detail: "Public cryptocurrency market data."
    };

  } catch (error) {
    services.Binance = {
      status: "unavailable",
      detail: errorText(error)
    };
  }

  // FOREX - FRANKFURTER REFERENCE RATES

  try {
    const response = await fetch(
      "https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,GBP,JPY,CHF,CAD",
      {
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(
        `Frankfurter HTTP ${response.status}`
      );
    }

    const data: any[] = await response.json();

    for (const row of data) {
      items.push({
        symbol: `USD/${row.quote}`,
        name: `USD to ${row.quote}`,
        category: "forex",
        price: Number(row.rate),
        currency: row.quote,
        source: "Frankfurter",
        updatedAt: row.date
      });
    }

    services.Frankfurter = {
      status: "online",
      detail: "Daily reference exchange rates; not live trading quotes."
    };

  } catch (error) {
    services.Frankfurter = {
      status: "unavailable",
      detail: errorText(error)
    };
  }

  // OPTIONAL: GOLD API

  try {
    const response = await fetch(
      "https://api.gold-api.com/price/XAU",
      {
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(`Gold API HTTP ${response.status}`);
    }

    const data: any = await response.json();

    const price = Number(data.price);

    if (Number.isFinite(price)) {
      items.push({
        symbol: "XAU/USD",
        name: "Gold",
        category: "commodity",
        price,
        currency: "USD",
        source: "Gold API",
        updatedAt: data.updatedAt || new Date().toISOString()
      });
    }

    services.Gold = {
      status: "online",
      detail: "Gold spot price from Gold API."
    };

  } catch (error) {
    services.Gold = {
      status: "unavailable",
      detail: errorText(error)
    };
  }

  // OIL - EIA API, OPTIONAL KEY

  if (process.env.EIA_API_KEY) {
    try {
      const url = new URL(
        "https://api.eia.gov/v2/petroleum/pri/spt/data/"
      );

      url.searchParams.set("api_key", process.env.EIA_API_KEY);
      url.searchParams.set("frequency", "daily");
      url.searchParams.set("data[0]", "value");
      url.searchParams.set("facets[product][]", "EPCWTI");
      url.searchParams.set("sort[0][column]", "period");
      url.searchParams.set("sort[0][direction]", "desc");
      url.searchParams.set("length", "1");

      const response = await fetch(url, {
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error(`EIA HTTP ${response.status}`);
      }

      const data: any = await response.json();
      const row = data.response?.data?.[0];

      if (row && Number.isFinite(Number(row.value))) {
        items.push({
          symbol: "WTI",
          name: "WTI Crude Oil",
          category: "commodity",
          price: Number(row.value),
          currency: "USD/barrel",
          source: "EIA",
          updatedAt: row.period
        });
      }

      services.EIA = {
        status: "online",
        detail: "Daily WTI price from US EIA."
      };

    } catch (error) {
      services.EIA = {
        status: "unavailable",
        detail: errorText(error)
      };
    }
  } else {
    services.EIA = {
      status: "needs_credentials",
      detail: "Set EIA_API_KEY in Render environment variables."
    };
  }

  res.json({
    items,
    services
  });
});
// EARTHQUAKES

app.get("/api/earthquakes", async (_req, res) => {
  try {
    const items = await cached("earthquakes", async () => {
      const response = await fetch(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
        {
          signal: AbortSignal.timeout(15000)
        }
      );

      if (!response.ok) {
        throw new Error(`USGS HTTP ${response.status}`);
      }

      const geo: any = await response.json();

      return (geo.features || []).map((feature: any) => ({
        id: feature.id,
        title: feature.properties.title,
        place: feature.properties.place,
        magnitude: feature.properties.mag,
        time: feature.properties.time,
        coordinates: [
          feature.geometry.coordinates[0],
          feature.geometry.coordinates[1]
        ],
        url: feature.properties.url
      }));
    });

    res.json({
      items,
      status: "online"
    });

  } catch (error) {
    console.error("USGS:", error);

    res.status(502).json({
      items: [],
      status: "unavailable",
      error: errorText(error)
    });
  }
});

// AIRCRAFT (ADSB.lol) and MARITIME (AISStream.io)
// Implemented in adsb.ts / ais.ts and registered through live.ts.

registerLiveRoutes(app);

// PROVIDER STATUS

app.get("/api/status", (_req, res) => {
  res.json({
    services: {
      "USGS Earthquakes": {
        status: "public",
        detail: "USGS public earthquake feed."
      },
      "RSS News": {
        status: "public",
        detail: "RSS and Atom sources."
      },
      "GDELT": {
        status: "public",
        detail: "Global news and event discovery API."
      },
      ...liveStatus(),
      "NASA GIBS": {
        status: "public",
        detail: "NASA satellite imagery tiles."
      }
    }
  });
});

// FRONTEND

const frontendDist = resolve(process.cwd(), "dist");

app.use(express.static(frontendDist));

app.get("*", (_req, res) => {
  res.sendFile(resolve(frontendDist, "index.html"));
});

startLive();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SHADOWBROKER listening on ${PORT}`);
});
