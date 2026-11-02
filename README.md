# SHADOWBROKER

A mobile-first, open-source intelligence dashboard starter. This repository contains a real React/TypeScript frontend, an Express API, MapLibre map, public-source adapters, and a basic PWA shell.

## Important data-integrity notes

- **Earthquakes:** live public USGS GeoJSON feed (past 24 hours).
- **News:** public RSS feeds from BBC, The Guardian, Al Jazeera, DW and NASA. Feed availability and publisher terms vary.
- **Aircraft:** ADSB.lol public API (no key). About 60 regional queries are merged every 60 seconds (`adsb.ts`). Coverage depends on community receivers.
- **Maritime AIS:** AISStream.io over a server-side WebSocket (`ais.ts`). Requires a free `AISSTREAM_API_KEY`. Without it the layer reports `needs credentials` and stays empty; nothing is simulated.
- **Conflicts / protests:** not mapped as live geolocated events in this initial release. News headlines are not sufficient evidence for a precise event coordinate. A vetted event dataset and geocoding/verification pipeline are required.
- **NASA FIRMS:** can be integrated using a free MAP_KEY, but registration is required and it is not enabled in this release.

No sample coordinates are presented as real observations. Provider failures are returned as unavailable instead of fabricated data.

## Requirements

- Node.js 20+
- npm 10+
- Internet access for package installation and public data endpoints

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Frontend: `http://localhost:5173`  
API: `http://localhost:8787/api/health`

## Production build

```bash
npm run typecheck
npm run build
```

The frontend build is written to `dist/`. The API is TypeScript source in `server.ts` and runs with `tsx` in production. The Express server serves the Vite `dist/` directory and the `/api/*` routes from one origin.

## Deployment architecture

For a single-service Render deployment:
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Render supplies the `PORT` environment variable; the Express server listens on it and serves both the API and the built frontend.
- Select the Free instance if available. Free-tier limits and availability can change.
- Database: not required by this initial release; add PostgreSQL when persistent user accounts, saved entities, and shared alert rules are implemented.

The Express server handles `/api/*` and serves `dist/` for the frontend, so no separate reverse proxy is required for this Render setup.

## Environment variables

See `.env.example`. Never commit `.env` or API credentials.

## PWA

The app includes a manifest, SVG icon, service worker, and offline app-shell fallback. Live map tiles and live API data require an internet connection. Install from Chrome's menu after deployment over HTTPS.

## Current scope and next engineering milestones

This is a functional first release, not a claim that every OSINT capability is complete:
1. Add a vetted GDELT event adapter and separate conflict/protest classification with source links and confidence.
2. ~~AIS adapter~~ done via AISStream.io (see `ais.ts`).
3. Add NASA FIRMS adapter after a free MAP_KEY is configured.
4. Add persistent Postgres storage, user-defined alert rules, deduplication and audit history.
5. Add automated tests, rate limiting, structured logs, provider health checks, and production deployment configuration.
6. Add a robust icon set and installability audit for target browsers.

## License

MIT for this project code. Third-party data remains subject to each provider's terms, attribution, and rate limits. Map tiles are provided by OpenFreeMap and subject to its service terms.


## Flat-file edition
All project files are intentionally placed in the repository root for easier upload from a mobile browser. Do not create `src`, `server`, or `public` folders.
