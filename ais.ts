// AISStream.io provider.
//
// AISStream is WebSocket-only and must be called from a server (never from
// the browser). This module keeps ONE connection open, stores the latest
// position per MMSI in memory, and /api/vessels simply returns that table.
//
// Required env var on Render:  AISSTREAM_API_KEY
//
// Protocol (https://aisstream.io/documentation):
//   wss://stream.aisstream.io/v0/stream
//   -> within 3 seconds send {"APIKey", "BoundingBoxes", "FilterMessageTypes"}
//   <- {"MessageType":"PositionReport","MetaData":{...},"Message":{"PositionReport":{...}}}

import WebSocket from "ws";
import type { Vessel } from "./types";

const STREAM_URL = process.env.AISSTREAM_URL || "wss://stream.aisstream.io/v0/stream";
const MAX_AGE_MS = (Number(process.env.AIS_MAX_AGE_MINUTES) || 20) * 60 * 1000;
const MAX_VESSELS = Number(process.env.AIS_MAX_VESSELS) || 8000;
const WATCHDOG_MS = 90 * 1000;

type StoredVessel = Vessel & {
  course: number | null;
  updatedAt: number;
};

// Whole world by default. Override with AIS_BBOX="lat1,lon1,lat2,lon2"
// (south-west corner first, then north-east corner).
function boundingBoxes() {
  const raw = process.env.AIS_BBOX;

  if (raw) {
    const p = raw.split(",").map(Number);

    if (p.length === 4 && p.every(Number.isFinite)) {
      return [[[p[0], p[1]], [p[2], p[3]]]];
    }
  }

  return [[[-90, -180], [90, 180]]];
}

const vessels = new Map<string, StoredVessel>();

const state = {
  status: "offline",
  detail: "not started",
  lastMessageAt: 0,
  received: 0
};

let socket: WebSocket | null = null;
let started = false;
let backoff = 2000;
let reconnectTimer: NodeJS.Timeout | null = null;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

function handle(message: any) {
  if (message?.error) {
    state.status = "offline";
    state.detail = `AISStream error: ${message.error}`;
    socket?.close();
    return;
  }

  if (message?.MessageType !== "PositionReport") return;

  const report = message.Message?.PositionReport;
  const meta = message.MetaData || {};

  if (!report) return;

  const lat = num(report.Latitude ?? meta.latitude);
  const lon = num(report.Longitude ?? meta.longitude);

  // AIS uses 91 / 181 for "not available"
  if (lat === null || lon === null) return;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  if (lat === 0 && lon === 0) return;

  const mmsi = String(report.UserID ?? meta.MMSI ?? "").trim();
  if (!mmsi) return;

  const sog = num(report.Sog);
  const trueHeading = num(report.TrueHeading);
  const course = num(report.Cog);

  const previous = vessels.get(mmsi);
  const shipName = String(meta.ShipName || "").trim();

  let heading: number | null = null;

  if (trueHeading !== null && trueHeading < 360) heading = trueHeading;
  else if (course !== null && course < 360) heading = course;

  vessels.set(mmsi, {
    mmsi,
    name: shipName || previous?.name || `MMSI ${mmsi}`,
    longitude: lon,
    latitude: lat,
    speed: sog === null || sog >= 102.3 ? null : sog,   // knots
    heading,
    course,
    updatedAt: Date.now()
  });

  state.received += 1;
  state.lastMessageAt = Date.now();
  state.status = "online";
  state.detail = `AISStream - ${vessels.size} vessels in memory`;
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);

  backoff = Math.min(backoff * 2, 60000);
}

function connect() {
  const key = process.env.AISSTREAM_API_KEY;

  if (!key) {
    state.status = "needs_credentials";
    state.detail = "Set AISSTREAM_API_KEY in the Render environment variables";
    return;
  }

  state.status = "offline";
  state.detail = "connecting to AISStream...";

  const ws = new WebSocket(STREAM_URL);
  socket = ws;

  ws.on("open", () => {
    // Must be sent within 3 seconds or the server closes the socket
    ws.send(
      JSON.stringify({
        APIKey: key,
        BoundingBoxes: boundingBoxes(),
        FilterMessageTypes: ["PositionReport"]
      })
    );

    backoff = 2000;
    state.detail = "connected, waiting for first positions...";
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      handle(JSON.parse(data.toString()));
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("error", (err: Error) => {
    state.status = "offline";
    state.detail = `AISStream connection error: ${err.message}`;
  });

  ws.on("close", (code: number) => {
    if (socket === ws) socket = null;

    state.status = "offline";

    if (!state.detail.startsWith("AISStream error")) {
      state.detail = `AISStream disconnected (code ${code}), retrying...`;
    }

    scheduleReconnect();
  });
}

function maintenance() {
  const now = Date.now();

  for (const [mmsi, vessel] of vessels) {
    if (now - vessel.updatedAt > MAX_AGE_MS) vessels.delete(mmsi);
  }

  // Hard cap: keep only the freshest records
  if (vessels.size > MAX_VESSELS * 1.5) {
    const newest = [...vessels.entries()]
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_VESSELS);

    vessels.clear();
    newest.forEach(([key, value]) => vessels.set(key, value));
  }

  // Connected but silent for too long -> force a reconnect
  if (
    socket &&
    socket.readyState === WebSocket.OPEN &&
    state.lastMessageAt &&
    now - state.lastMessageAt > WATCHDOG_MS
  ) {
    socket.terminate();
  }
}

export function startAis() {
  if (started) return;
  started = true;

  connect();
  setInterval(maintenance, 30000).unref();
}

export function getVessels() {
  const now = Date.now();

  const items = [...vessels.values()]
    .filter(vessel => now - vessel.updatedAt <= MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_VESSELS);

  return {
    items,
    status: state.status,
    detail: state.detail
  };
}

export function aisStatus() {
  return {
    status: state.status,
    detail: state.detail
  };
}
