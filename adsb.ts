// ADSB.lol provider (public API, no key).
//
// The API answers "aircraft within N nautical miles of a point" (max 250 nm),
// so global coverage is built by polling a list of regional centres and
// merging the results by ICAO hex.
//
//   GET https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}  ->  { ac: [...] }

import type { Flight } from "./types";

const BASE = (process.env.ADSB_BASE_URL || "https://api.adsb.lol").replace(/\/$/, "");
const RADIUS_NM = Math.min(Number(process.env.ADSB_RADIUS_NM) || 250, 250);
const TTL_MS = (Number(process.env.ADSB_REFRESH_SECONDS) || 60) * 1000;
const CONCURRENCY = Number(process.env.ADSB_CONCURRENCY) || 4;
const MAX_AIRCRAFT = Number(process.env.ADSB_MAX_AIRCRAFT) || 8000;

// [name, lat, lon] - dense air-traffic regions. Add or remove freely.
const HUBS: [string, number, number][] = [
  // Europe
  ["London", 51.5, -0.5], ["Frankfurt", 50.0, 8.5], ["Madrid", 40.4, -3.6],
  ["Rome", 41.8, 12.5], ["Istanbul", 41.0, 28.9], ["Stockholm", 59.6, 18.0],
  ["Moscow", 55.9, 37.4], ["Warsaw", 52.2, 21.0], ["Athens", 37.9, 23.9],
  ["Reykjavik", 64.0, -22.6],
  // Middle East / Central Asia
  ["Dubai", 25.2, 55.4], ["Tehran", 35.4, 51.1], ["Riyadh", 24.9, 46.7],
  ["Cairo", 30.1, 31.4], ["Tel Aviv", 32.0, 34.9], ["Baku", 40.5, 50.0],
  ["Tashkent", 41.3, 69.3], ["Almaty", 43.3, 77.0], ["Karachi", 24.9, 67.2],
  // Asia
  ["Delhi", 28.6, 77.1], ["Mumbai", 19.1, 72.9], ["Bangkok", 13.7, 100.7],
  ["Singapore", 1.4, 103.9], ["Jakarta", -6.1, 106.7], ["Manila", 14.5, 121.0],
  ["Hong Kong", 22.3, 113.9], ["Shanghai", 31.1, 121.8], ["Beijing", 40.1, 116.6],
  ["Seoul", 37.5, 126.4], ["Tokyo", 35.5, 139.8],
  // Oceania
  ["Sydney", -33.9, 151.2], ["Melbourne", -37.7, 144.8], ["Brisbane", -27.4, 153.1],
  ["Perth", -31.9, 115.9], ["Auckland", -37.0, 174.8],
  // Africa
  ["Johannesburg", -26.1, 28.2], ["Nairobi", -1.3, 36.9], ["Lagos", 6.6, 3.3],
  ["Addis Ababa", 9.0, 38.8], ["Casablanca", 33.4, -7.6], ["Algiers", 36.7, 3.2],
  // North America
  ["New York", 40.6, -73.8], ["Boston", 42.4, -71.0], ["Atlanta", 33.6, -84.4],
  ["Miami", 25.8, -80.3], ["Chicago", 41.9, -87.9], ["Dallas", 32.9, -97.0],
  ["Denver", 39.9, -104.7], ["Los Angeles", 33.9, -118.4], ["San Francisco", 37.6, -122.4],
  ["Seattle", 47.4, -122.3], ["Toronto", 43.7, -79.6], ["Mexico City", 19.4, -99.1],
  ["Anchorage", 61.2, -150.0], ["Honolulu", 21.3, -157.9],
  // South America
  ["Sao Paulo", -23.4, -46.5], ["Bogota", 4.7, -74.1], ["Lima", -12.0, -77.1],
  ["Santiago", -33.4, -70.8], ["Buenos Aires", -34.8, -58.5]
];

type FlightResult = {
  items: Flight[];
  at: number;
  ok: boolean;
  detail: string;
};

const cache: FlightResult = {
  items: [],
  at: 0,
  ok: false,
  detail: "not fetched yet"
};

let inflight: Promise<void> | null = null;

const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

function normalize(ac: Record<string, unknown>): Flight | null {
  // Number(null) === 0, so null/undefined must be rejected BEFORE conversion.
  const lat = num(ac.lat);
  const lon = num(ac.lon);

  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;

  const hex = String(ac.hex || "").trim().toLowerCase();
  if (!hex) return null;

  const onGround = ac.alt_baro === "ground";
  const altFt = onGround ? 0 : num(ac.alt_baro);
  const gs = num(ac.gs);

  return {
    icao24: hex,
    callsign: String(ac.flight || "").trim(),
    originCountry: "",                                              // not provided by ADSB.lol
    longitude: lon,
    latitude: lat,
    altitude: altFt === null ? null : Math.round(altFt * FT_TO_M),  // metres
    velocity: gs === null ? null : Math.round(gs * KT_TO_MS),       // m/s
    heading: num(ac.track),
    registration: ac.r ? String(ac.r) : null,
    aircraftType: ac.t ? String(ac.t) : null,
    onGround
  };
}

async function fetchRegion([name, lat, lon]: [string, number, number]) {
  const url = `${BASE}/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SHADOWBROKER/2.0"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  const data = (await response.json()) as { ac?: Record<string, unknown>[] };
  return Array.isArray(data.ac) ? data.ac : [];
}

async function pool<T>(
  list: T[],
  size: number,
  worker: (item: T) => Promise<void>
) {
  let next = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < list.length) {
        const item = list[next++];
        await worker(item);
      }
    })
  );
}

function refresh(): Promise<void> {
  if (inflight) return inflight;

  inflight = (async () => {
    const merged = new Map<string, Flight>();
    let ok = 0;
    let lastError = "";

    await pool(HUBS, CONCURRENCY, async hub => {
      try {
        const list = await fetchRegion(hub);
        ok += 1;

        for (const raw of list) {
          const flight = normalize(raw);
          if (flight) merged.set(flight.icao24, flight);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    });

    cache.at = Date.now();

    if (merged.size > 0) {
      cache.items = [...merged.values()].slice(0, MAX_AIRCRAFT);
      cache.ok = true;
      cache.detail =
        `ADSB.lol - ${cache.items.length} aircraft - ` +
        `${ok}/${HUBS.length} regions` +
        (lastError ? ` - last error: ${lastError}` : "");
    } else {
      // Keep the previous snapshot rather than blanking the map
      cache.ok = cache.items.length > 0;
      cache.detail = `ADSB.lol unreachable: ${lastError || "no data returned"}`;
    }
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export async function getFlights(): Promise<FlightResult> {
  if (!cache.at) {
    await refresh();               // first request waits for real data
  } else if (Date.now() - cache.at > TTL_MS) {
    void refresh();                // later requests get the cache instantly
  }

  return cache;
}

export function startAdsb() {
  void refresh();
  setInterval(() => void refresh(), TTL_MS).unref();
}

export function adsbStatus() {
  return {
    status: cache.ok ? "public" : "offline",
    detail: cache.detail
  };
}
