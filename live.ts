import type { Express } from "express";
import { getFlights, startAdsb, adsbStatus } from "./adsb";
import { getVessels, startAis, aisStatus } from "./ais";

/** Start background polling and the AISStream WebSocket. Call once at boot. */
export function startLive() {
  startAdsb();
  startAis();
}

/** Registers GET /api/flights and GET /api/vessels. */
export function registerLiveRoutes(app: Express) {
  app.get("/api/flights", async (_req, res) => {
    try {
      const data = await getFlights();

      res.set("Cache-Control", "no-store");
      res.json({
        items: data.items,
        count: data.items.length,
        status: data.ok ? "online" : "unavailable",
        detail: data.detail
      });
    } catch (err) {
      res.status(502).json({
        items: [],
        count: 0,
        status: "unavailable",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  app.get("/api/vessels", (_req, res) => {
    const data = getVessels();

    res.set("Cache-Control", "no-store");
    res.json({
      items: data.items,
      count: data.items.length,
      status: data.status,
      detail: data.detail
    });
  });
}

/** Provider entries merged into the /api/status response. */
export function liveStatus() {
  return {
    "ADSB.lol": adsbStatus(),
    "AISStream.io": aisStatus()
  };
}
