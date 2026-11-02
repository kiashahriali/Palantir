import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import maplibregl, {
  Map as MapLibreMap
} from "maplibre-gl";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  Activity,
  AlertTriangle,
  Anchor,
  Bell,
  Crosshair,
  Globe2,
  Layers,
  Menu,
  Newspaper,
  Plane,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  X,
  Zap,
  Satellite,
  Plus,
  Trash2,
  Palette,
  ChartNoAxesCombined,
  TrendingUp,
  TrendingDown,
  Coins,
  CircleDollarSign
} from "lucide-react";

import { api } from "./api";

import type {
  Earthquake,
  FeedItem,
  Flight,
  LayerState,
  Vessel,
  NewsSource,
  ProviderStatus,
  MarketAsset
} from "./types";

import "./style.css";

const initialLayers: LayerState = {
  flights: true,
  earthquakes: true,
  conflicts: true,
  protests: true,
  vessels: true,
  satellite: false
};

const defaultTheme = {
  accent: "#53c7f4",
  background: "#07111a",
  panel: "#08131b",
  news: "#ef4444",
  aircraft: "#53c7f4",
  vessels: "#40d9c2",
  earthquakes: "#ffb454",
  conflicts: "#ff5252",
  protests: "#bd83ff",
  countryLabels: "#dce8ef"
};

const timeLabel = (date?: string) =>
  date ? new Date(date).toLocaleString() : "Time unavailable";

type Tab =
  | "news"
  | "alerts"
  | "sources"
  | "settings"
  | "markets";

type MarketFilter =
  | "all"
  | "crypto"
  | "forex"
  | "commodity"
  | "stock";

type AlertItem = {
  id: string;
  title: string;
  detail: string;
  time: number;
};

type Theme = typeof defaultTheme;

type Entity = FeedItem | Earthquake | Flight | Vessel;

const marketFilters: {
  id: MarketFilter;
  label: string;
}[] = [
  { id: "all", label: "ALL" },
  { id: "crypto", label: "CRYPTO" },
  { id: "forex", label: "FOREX" },
  { id: "commodity", label: "COMMODITIES" },
  { id: "stock", label: "STOCKS" }
];

function formatPrice(value: number | null, currency: string) {
  if (value === null || !Number.isFinite(value)) return "—";

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 1 ? 6 : 2
  }).format(value) + ` ${currency}`;
}

function formatChange(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// MAP ENTITY LAYERS (GeoJSON — replaces DOM markers)

const ENTITY_LAYERS = [
  { id: "quakes", radius: 6 },
  { id: "vessels", radius: 4 },
  { id: "flights", radius: 3.5 }
] as const;

type EntityLayerId = (typeof ENTITY_LAYERS)[number]["id"];

const SATELLITE_LAYER = "sb-satellite-layer";

/**
 * Returns [lon, lat] or null when the position is unusable.
 * Null / empty / NaN / out of range / (0,0) are all rejected so
 * they can never pile up on a single point.
 */
const validCoord = (
  lon: unknown,
  lat: unknown
): [number, number] | null => {
  if (lon == null || lat == null || lon === "" || lat === "") return null;

  const x = Number(lon);
  const y = Number(lat);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 180 || Math.abs(y) > 90) return null;
  if (x === 0 && y === 0) return null; // Null Island

  return [x, y];
};

// Local GeoJSON types (the global `GeoJSON` namespace is not available
// in every tsconfig setup, so we don't depend on it).
type GeoFeature = {
  type: "Feature";
  properties: { key: string };
  geometry: { type: "Point"; coordinates: [number, number] };
};

type GeoCollection = {
  type: "FeatureCollection";
  features: GeoFeature[];
};

const emptyCollection = (): GeoCollection => ({
  type: "FeatureCollection",
  features: []
});

function ensureEntityLayers(map: MapLibreMap) {
  ENTITY_LAYERS.forEach(({ id, radius }) => {
    if (!map.getSource(`sb-${id}`)) {
      map.addSource(`sb-${id}`, {
        type: "geojson",
        data: emptyCollection()
      });
    }

    if (!map.getLayer(`sb-${id}-layer`)) {
      map.addLayer({
        id: `sb-${id}-layer`,
        type: "circle",
        source: `sb-${id}`,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            1,
            radius,
            8,
            radius + 3
          ],
          "circle-color": "#53c7f4",
          "circle-opacity": 0.88,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#07111a"
        }
      });
    }
  });
}

export default function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const satelliteAdded = useRef(false);
  const loadingRef = useRef(false);
  const entityIndex = useRef<Record<string, Entity>>({});

  const [layers, setLayers] = useState<LayerState>(() => {
    try {
      const saved = localStorage.getItem("sb-layers");

      return {
        ...initialLayers,
        ...(saved ? JSON.parse(saved) : {})
      };
    } catch {
      return initialLayers;
    }
  });

  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("sb-theme");

      return {
        ...defaultTheme,
        ...(saved ? JSON.parse(saved) : {})
      };
    } catch {
      return defaultTheme;
    }
  });

  const [news, setNews] = useState<FeedItem[]>([]);
  const [events, setEvents] = useState<FeedItem[]>([]);
  const [quakes, setQuakes] = useState<Earthquake[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);

  const [flightInfo, setFlightInfo] = useState("");
  const [vesselInfo, setVesselInfo] = useState("");

  // Records the backend sent without a usable position
  const [dropped, setDropped] = useState<Record<string, number>>({});

  const [serviceStatus, setServiceStatus] =
    useState<Record<string, ProviderStatus>>({});

  const [sourceStatus, setSourceStatus] = useState<
    { source: string; status: string; error?: string }[]
  >([]);

  const [sources, setSources] = useState<NewsSource[]>([]);

  const [marketItems, setMarketItems] = useState<MarketAsset[]>([]);
  const [marketServices, setMarketServices] = useState<
    Record<string, ProviderStatus>
  >({});
  const [marketFilter, setMarketFilter] =
    useState<MarketFilter>("all");
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const marketLoadingRef = useRef(false);

  const [activeTab, setActiveTab] = useState<Tab>("news");

  const [selected, setSelected] = useState<Entity | null>(null);

  const [query, setQuery] = useState("");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState("");

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");

  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceCategory, setNewSourceCategory] =
    useState("world");

  const [sourceMessage, setSourceMessage] = useState("");
  const [tickerPaused, setTickerPaused] = useState(false);

  // DATA LOADING

  const load = async () => {
    if (loadingRef.current) return;

    loadingRef.current = true;
    setBusy(true);
    setError("");

    try {
      const results = await Promise.allSettled([
        api.news(),
        api.events(),
        api.earthquakes(),
        api.flights(),
        api.vessels(),
        api.status(),
        api.sources()
      ]);

      if (results[0].status === "fulfilled") {
        setNews(results[0].value.items || []);
        setSourceStatus(results[0].value.sourceStatus || []);
      }

      if (results[1].status === "fulfilled") {
        setEvents(results[1].value.items || []);
      }

      if (results[2].status === "fulfilled") {
        setQuakes(results[2].value.items || []);
      }

      if (results[3].status === "fulfilled") {
        setFlights(results[3].value.items || []);
        setFlightInfo(
          results[3].value.detail || results[3].value.status || ""
        );
      }

      if (results[4].status === "fulfilled") {
        setVessels(results[4].value.items || []);
        setVesselInfo(
          results[4].value.detail || results[4].value.status || ""
        );
      }

      if (results[5].status === "fulfilled") {
        setServiceStatus(results[5].value.services || {});
      }

      if (results[6].status === "fulfilled") {
        setSources(results[6].value.items || []);
      }

      const names = [
        "news",
        "events",
        "earthquakes",
        "flights",
        "vessels",
        "status",
        "sources"
      ];

      const failures = results
        .map((result, index) =>
          result.status === "rejected"
            ? `${names[index]}: ${
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason)
              }`
            : null
        )
        .filter(Boolean) as string[];

      if (failures.length > 0) {
        console.warn("[load] failed:", failures);
        setError(failures.join(" | "));
      }

      setLastUpdated(new Date());

    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  };

  // MARKET DATA

  const loadMarkets = async () => {
    if (marketLoadingRef.current) return;

    marketLoadingRef.current = true;
    setMarketLoading(true);
    setMarketError("");

    try {
      const result = await api.markets();

      setMarketItems(result.items || []);
      setMarketServices(result.services || {});
    } catch (err: unknown) {
      setMarketError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      marketLoadingRef.current = false;
      setMarketLoading(false);
    }
  };

  useEffect(() => {
    void load();

    const timer = window.setInterval(() => {
      void load();
    }, 120000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadMarkets();

    const timer = window.setInterval(() => {
      void loadMarkets();
    }, 120000);

    return () => window.clearInterval(timer);
  }, []);

  // LOCAL SETTINGS

  useEffect(() => {
    localStorage.setItem("sb-layers", JSON.stringify(layers));
  }, [layers]);

  useEffect(() => {
    localStorage.setItem("sb-theme", JSON.stringify(theme));

    Object.entries(theme).forEach(([key, value]) => {
      document.documentElement.style.setProperty(
        `--sb-${key}`,
        String(value)
      );
    });
  }, [theme]);

  // SATELLITE LAYER

  function addSatelliteLayer(map: MapLibreMap) {
    if (satelliteAdded.current) return;

    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 2);

    const imageDate = date.toISOString().slice(0, 10);

    const tileUrl =
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` +
      `MODIS_Terra_CorrectedReflectance_TrueColor/default/` +
      `${imageDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

    try {
      if (!map.getSource("sb-satellite")) {
        map.addSource("sb-satellite", {
          type: "raster",
          tiles: [tileUrl],
          tileSize: 256,
          maxzoom: 9,
          attribution: "NASA GIBS / NASA Earthdata"
        });
      }

      if (!map.getLayer(SATELLITE_LAYER)) {
        // Insert below the entity layers so markers always stay on top
        const beforeId = map.getLayer("sb-quakes-layer")
          ? "sb-quakes-layer"
          : undefined;

        map.addLayer(
          {
            id: SATELLITE_LAYER,
            type: "raster",
            source: "sb-satellite",
            layout: {
              visibility: "none"
            },
            paint: {
              "raster-opacity": 0.9
            }
          },
          beforeId
        );
      }

      satelliteAdded.current = true;
    } catch (err) {
      console.error("Satellite layer:", err);
    }
  }

  function updateSatelliteVisibility(
    map: MapLibreMap,
    visible: boolean
  ) {
    if (!map.isStyleLoaded()) return;

    if (!map.getLayer(SATELLITE_LAYER)) {
      addSatelliteLayer(map);
    }

    if (map.getLayer(SATELLITE_LAYER)) {
      map.setLayoutProperty(
        SATELLITE_LAYER,
        "visibility",
        visible ? "visible" : "none"
      );
    }
  }

  // MAP INITIALIZATION

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapNode.current,
      style:
        import.meta.env.VITE_MAP_STYLE ||
        "https://tiles.openfreemap.org/styles/dark",
      center: [18, 22],
      zoom: 1.65,
      minZoom: 1.2,
      maxZoom: 16,
      attributionControl: {}
    });

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true
      }),
      "top-right"
    );

    map.addControl(
      new maplibregl.ScaleControl({
        unit: "metric"
      }),
      "bottom-left"
    );

    map.on("load", () => {
      // Entity layers first, then satellite beneath them
      ensureEntityLayers(map);

      satelliteAdded.current = false;
      addSatelliteLayer(map);

      ENTITY_LAYERS.forEach(({ id }) => {
        const layerId = `sb-${id}-layer`;

        map.on("click", layerId, event => {
          const key = event.features?.[0]?.properties?.key;
          const item = key ? entityIndex.current[key] : undefined;

          if (item) setSelected(item);
        });

        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });

        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      });

      setMapError("");
      setMapReady(true);
    });

    map.on("error", event => {
      console.error("MapLibre error:", event.error);

      if (!map.isStyleLoaded()) {
        setMapReady(false);
        setMapError(
          event.error?.message || "Map style could not be loaded."
        );
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      satelliteAdded.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !mapReady) return;

    updateSatelliteVisibility(map, layers.satellite);
  }, [layers.satellite, mapReady]);

  // MAP ENTITIES (flights / vessels / earthquakes)

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !mapReady) return;

    ensureEntityLayers(map);

    const index: Record<string, Entity> = {};
    const skipped: Record<string, number> = {};

    const toCollection = <T,>(
      prefix: EntityLayerId,
      items: T[],
      coords: (item: T) => [unknown, unknown]
    ): GeoCollection => {
      const features: GeoFeature[] = [];

      items.forEach((item, i) => {
        const c = validCoord(...coords(item));

        if (!c) {
          skipped[prefix] = (skipped[prefix] || 0) + 1;
          return;
        }

        const key = `${prefix}:${i}`;
        index[key] = item as unknown as Entity;

        features.push({
          type: "Feature",
          properties: { key },
          geometry: {
            type: "Point",
            coordinates: c
          }
        });
      });

      return {
        type: "FeatureCollection",
        features
      };
    };

    const apply = (
      id: EntityLayerId,
      data: GeoCollection,
      visible: boolean,
      color: string
    ) => {
      const source = map.getSource(`sb-${id}`) as
        | maplibregl.GeoJSONSource
        | undefined;

      source?.setData(
        data as unknown as Parameters<maplibregl.GeoJSONSource["setData"]>[0]
      );

      map.setLayoutProperty(
        `sb-${id}-layer`,
        "visibility",
        visible ? "visible" : "none"
      );

      map.setPaintProperty(`sb-${id}-layer`, "circle-color", color);
    };

    apply(
      "flights",
      toCollection("flights", flights, f => [f.longitude, f.latitude]),
      layers.flights,
      theme.aircraft
    );

    apply(
      "vessels",
      toCollection("vessels", vessels, v => [v.longitude, v.latitude]),
      layers.vessels,
      theme.vessels
    );

    apply(
      "quakes",
      toCollection("quakes", quakes, q => [
        q.coordinates?.[0],
        q.coordinates?.[1]
      ]),
      layers.earthquakes,
      theme.earthquakes
    );

    entityIndex.current = index;
    setDropped(skipped);

    console.debug(
      "[map] records without valid position:",
      skipped,
      "| raw counts:",
      {
        flights: flights.length,
        vessels: vessels.length,
        quakes: quakes.length
      }
    );
  }, [mapReady, layers, quakes, flights, vessels, theme]);

  // NEWS

  const allNews = useMemo(() => {
    const combined = [...news, ...events];
    const unique = new Map<string, FeedItem>();

    combined.forEach(item => {
      const key = item.url || item.title;

      if (!unique.has(key)) {
        unique.set(key, item);
      }
    });

    return [...unique.values()].sort((a, b) =>
      new Date(b.publishedAt || 0).getTime() -
      new Date(a.publishedAt || 0).getTime()
    );
  }, [news, events]);

  const filteredNews = useMemo(() => {
    const value = query.toLowerCase();

    return allNews.filter(item =>
      `${item.title} ${item.source} ${item.summary || ""}`
        .toLowerCase()
        .includes(value)
    );
  }, [allNews, query]);

  const tickerItems = useMemo(
    () => allNews.slice(0, 20),
    [allNews]
  );

  // ALERTS

  const alerts = useMemo<AlertItem[]>(() => [
    ...quakes
      .filter(quake => quake.magnitude >= 4.5)
      .map(quake => ({
        id: quake.id,
        title: `Magnitude ${quake.magnitude.toFixed(1)} earthquake`,
        detail: quake.place,
        time: quake.time
      })),

    ...events.map(item => ({
      id: item.id,
      title: item.title,
      detail: item.source,
      time: item.publishedAt
        ? new Date(item.publishedAt).getTime()
        : 0
    }))
  ]
    .sort((a, b) => b.time - a.time)
    .slice(0, 50), [quakes, events]);

  // FILTERED MARKETS

  const filteredMarkets = useMemo(() => {
    if (marketFilter === "all") return marketItems;

    return marketItems.filter(
      item => item.category === marketFilter
    );
  }, [marketItems, marketFilter]);

  const marketCounts = useMemo(() => ({
    all: marketItems.length,
    crypto: marketItems.filter(item => item.category === "crypto").length,
    forex: marketItems.filter(item => item.category === "forex").length,
    commodity: marketItems.filter(item => item.category === "commodity").length,
    stock: marketItems.filter(item => item.category === "stock").length
  }), [marketItems]);

  // HELPERS

  const toggle = (key: keyof LayerState) => {
    setLayers(value => ({
      ...value,
      [key]: !value[key]
    }));
  };

  const isFeed = (value: Entity): value is FeedItem =>
    "source" in value && "url" in value;

  const isVessel = (value: Entity): value is Vessel =>
    "mmsi" in value;

  const addNewsSource = async () => {
    setSourceMessage("");

    try {
      const result = await api.addSource({
        name: newSourceName,
        url: newSourceUrl,
        category: newSourceCategory
      });

      setSourceMessage(`Added ${result.source.name}`);

      setNewSourceName("");
      setNewSourceUrl("");

      const updated = await api.sources();
      setSources(updated.items);

      await load();

    } catch (err: unknown) {
      setSourceMessage(
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const removeNewsSource = async (url: string) => {
    try {
      await api.removeSource(url);

      const updated = await api.sources();
      setSources(updated.items);

      await load();

    } catch (err: unknown) {
      setSourceMessage(
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const setColor = (
    key: keyof Theme,
    value: string
  ) => {
    setTheme((old: Theme) => ({
      ...old,
      [key]: value
    }));
  };

  const setSatelliteMode = () => {
    setLayers(old => ({
      ...old,
      satellite: !old.satellite
    }));
  };

  const layerDetail = (
    count: number,
    word: string,
    info: string,
    skipped?: number
  ) => {
    if (!count) return info || "no data";

    return skipped
      ? `${count} ${word} · ${skipped} no position`
      : `${count} ${word}`;
  };

  // RENDER

  return (
    <div className="app-shell">

      <header className="topbar">

        <button
          className="icon-button mobile-only"
          onClick={() => setMobilePanel(!mobilePanel)}
          aria-label="Menu"
        >
          <Menu size={19}/>
        </button>

        <div className="brand">
          <div className="brand-mark">
            <Shield size={19}/>
          </div>

          <div>
            <div className="brand-name">
              SHADOW<span>BROKER</span>
            </div>

            <div className="brand-sub">
              GLOBAL INTELLIGENCE PLATFORM
            </div>
          </div>
        </div>

        <nav className="main-navigation">

          <button
            className={activeTab === "news" ? "active" : ""}
            onClick={() => setActiveTab("news")}
          >
            <Globe2 size={15}/> WORLD
          </button>

          <button
            className={activeTab === "sources" ? "active" : ""}
            onClick={() => setActiveTab("sources")}
          >
            <Newspaper size={15}/> SOURCES
          </button>

          <button
            className={activeTab === "markets" ? "active" : ""}
            onClick={() => setActiveTab("markets")}
          >
            <ChartNoAxesCombined size={15}/> MARKETS
          </button>

        </nav>

        <div className="top-status">
          <span className="live-dot"/>
          GLOBAL MONITOR
          <span className="status-divider"/>
          {lastUpdated
            ? `UPDATED ${lastUpdated.toLocaleTimeString()}`
            : "CONNECTING"}
        </div>

        <div className="top-actions">

          <button
            className="icon-button"
            onClick={() => {
              void load();
              void loadMarkets();
            }}
            title="Refresh"
          >
            <RefreshCw
              size={17}
              className={busy || marketLoading ? "spin" : ""}
            />
          </button>

          <button
            className="icon-button"
            onClick={() => setActiveTab("settings")}
            title="Appearance"
          >
            <Palette size={17}/>
          </button>

        </div>
      </header>

      <main className="workspace">

        <aside className={`left-rail ${mobilePanel ? "show" : ""}`}>

          <div className="rail-heading">
            <span>INTELLIGENCE LAYERS</span>
            <Layers size={15}/>
          </div>

          <div className="layer-list">

            <Layer
              icon={<Plane size={16}/>}
              name="Aircraft"
              detail={layerDetail(
                flights.length,
                "tracked",
                flightInfo,
                dropped.flights
              )}
              checked={layers.flights}
              onClick={() => toggle("flights")}
              color="blue"
            />

            <Layer
              icon={<Activity size={16}/>}
              name="Earthquakes"
              detail={`${quakes.length} events`}
              checked={layers.earthquakes}
              onClick={() => toggle("earthquakes")}
              color="amber"
            />

            <Layer
              icon={<AlertTriangle size={16}/>}
              name="Conflicts"
              detail="GDELT reports"
              checked={layers.conflicts}
              onClick={() => toggle("conflicts")}
              color="red"
            />

            <Layer
              icon={<Radio size={16}/>}
              name="Protests"
              detail="GDELT reports"
              checked={layers.protests}
              onClick={() => toggle("protests")}
              color="purple"
            />

            <Layer
              icon={<Anchor size={16}/>}
              name="Maritime / AIS"
              detail={layerDetail(
                vessels.length,
                "vessels",
                vesselInfo,
                dropped.vessels
              )}
              checked={layers.vessels}
              onClick={() => toggle("vessels")}
              color="cyan"
            />

            <Layer
              icon={<Satellite size={16}/>}
              name="Satellite imagery"
              detail={layers.satellite ? "NASA GIBS" : "Dark map"}
              checked={layers.satellite}
              onClick={setSatelliteMode}
              color="green"
            />

          </div>

          <div className="rail-heading section-gap">
            <span>MAP CONTROLS</span>
            <Crosshair size={15}/>
          </div>

          <div className="map-controls">

            <button
              onClick={() =>
                mapRef.current?.flyTo({
                  center: [18, 22],
                  zoom: 1.65
                })
              }
            >
              <Globe2 size={15}/>
              Reset global view
            </button>

            <button
              onClick={() =>
                mapRef.current?.easeTo({
                  zoom: Math.min(
                    (mapRef.current?.getZoom() || 1) + 1,
                    16
                  )
                })
              }
            >
              <Search size={15}/>
              Zoom in
            </button>

          </div>

          <div className="rail-foot">
            <span className="tiny-led"/>
            PUBLIC DATA
            <span className="foot-right">v2.1.0</span>
          </div>

        </aside>

        <section className="map-section">

          <div className="map-title">
            <div>
              <span className="eyebrow">
                GLOBAL SITUATIONAL AWARENESS
              </span>
              <h1>World monitor</h1>
            </div>

            <div className="map-coords">
              GLOBAL VIEW <span>•</span> WGS84
            </div>
          </div>

          <div className="map-wrap">

            <div
              ref={mapNode}
              className="map-canvas"
            />

            {!mapReady && (
              <div className="map-loading">
                <RefreshCw size={20} className="spin"/>
                <span>
                  {mapError ? "MAP UNAVAILABLE" : "INITIALIZING MAP"}
                </span>
                {mapError && (
                  <small>{mapError}</small>
                )}
              </div>
            )}

            {mapReady && mapError && (
              <div className="map-error">
                MAP WARNING: {mapError}
              </div>
            )}

            <div className="map-overlay map-overlay-top">

              <span className={`map-chip ${mapReady ? "online" : "offline"}`}>
                <span className="live-dot"/>
                {mapReady ? "MAP ONLINE" : "MAP OFFLINE"}
              </span>

              <span className="map-chip">
                {layers.satellite
                  ? "NASA SATELLITE"
                  : "DARK MAP"}
              </span>

            </div>

            <div className="map-overlay map-overlay-bottom">
              <span>SELECT A POINT TO INSPECT</span>

              <span>
                {flights.length} AIRCRAFT ·{" "}
                {vessels.length} VESSELS ·{" "}
                {quakes.length} SEISMIC EVENTS
              </span>
            </div>

            {selected && (
              <div className="inspector">

                <button
                  className="close-inspector"
                  onClick={() => setSelected(null)}
                >
                  <X size={16}/>
                </button>

                <div className="eyebrow">
                  ENTITY INSPECTOR
                </div>

                {isFeed(selected) ? (
                  <>
                    <h3>{selected.title}</h3>
                    <p>{selected.summary}</p>

                    <div className="inspector-meta">
                      {selected.source} ·{" "}
                      {timeLabel(selected.publishedAt)}
                    </div>

                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      OPEN ORIGINAL SOURCE ↗
                    </a>
                  </>
                ) : "magnitude" in selected ? (
                  <>
                    <h3>{selected.title}</h3>
                    <p>{selected.place}</p>

                    <div className="inspector-meta">
                      Magnitude {selected.magnitude} ·{" "}
                      {timeLabel(
                        new Date(selected.time).toISOString()
                      )}
                    </div>

                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      USGS EVENT ↗
                    </a>
                  </>
                ) : isVessel(selected) ? (
                  <>
                    <h3>{selected.name}</h3>
                    <p>MMSI: {selected.mmsi}</p>

                    <div className="inspector-meta">
                      Speed: {selected.speed ?? "—"} knots ·{" "}
                      Heading: {selected.heading ?? "—"}
                    </div>
                  </>
                ) : (
                  <>
                    <h3>
                      {selected.callsign || selected.icao24}
                    </h3>

                    <p>{selected.originCountry}</p>

                    <div className="inspector-meta">
                      Altitude {selected.altitude ?? "—"} m ·{" "}
                      Speed {selected.velocity ?? "—"} m/s
                    </div>
                  </>
                )}

              </div>
            )}

          </div>

          <div className="map-footer">
            <span>
              <span className="legend-dot blue"/>
              Aircraft
            </span>

            <span>
              <span className="legend-dot amber"/>
              Earthquakes
            </span>

            <span>
              <span className="legend-dot red"/>
              Conflicts
            </span>

            <span>
              <span className="legend-dot purple"/>
              Protests
            </span>

            <span>
              <span className="legend-dot cyan"/>
              Vessels
            </span>

            <span className="map-footer-right">
              NASA GIBS / OpenFreeMap
            </span>
          </div>

        </section>

        <aside className="right-panel">

          <div className="panel-tabs">

            <button
              className={activeTab === "news" ? "active" : ""}
              onClick={() => setActiveTab("news")}
            >
              <Newspaper size={15}/> NEWS
            </button>

            <button
              className={activeTab === "alerts" ? "active" : ""}
              onClick={() => setActiveTab("alerts")}
            >
              <Bell size={15}/> ALERTS
              <span className="tab-count">{alerts.length}</span>
            </button>

            <button
              className={activeTab === "sources" ? "active" : ""}
              onClick={() => setActiveTab("sources")}
            >
              <Radio size={15}/> SOURCES
            </button>

            <button
              className={activeTab === "markets" ? "active" : ""}
              onClick={() => setActiveTab("markets")}
              title="Markets"
            >
              <ChartNoAxesCombined size={15}/>
            </button>

            <button
              className={activeTab === "settings" ? "active" : ""}
              onClick={() => setActiveTab("settings")}
              title="Settings"
            >
              <Settings2 size={15}/>
            </button>

          </div>

          {activeTab === "news" && (
            <div className="panel-content">

              <div className="panel-intro">
                <div>
                  <div className="eyebrow">GLOBAL NEWSWIRE</div>
                  <h2>Latest reports</h2>
                </div>

                <span className="count-pill">
                  {filteredNews.length} ITEMS
                </span>
              </div>

              <div className="search-box">
                <Search size={15}/>

                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Search headlines or sources"
                />
              </div>

              {error && (
                <div className="inline-warning">{error}</div>
              )}

              <div className="feed-list">

                {filteredNews.map(item => (
                  <button
                    className="feed-item"
                    key={item.id}
                    onClick={() => setSelected(item)}
                  >
                    <div className="feed-meta">
                      <span className={`category ${item.category}`}>
                        {item.category.toUpperCase()}
                      </span>

                      <span>{item.source}</span>
                    </div>

                    <h3>{item.title}</h3>
                    <p>{item.summary}</p>

                    <div className="feed-time">
                      {timeLabel(item.publishedAt)}
                      <span>OPEN REPORT ↗</span>
                    </div>
                  </button>
                ))}

                {!filteredNews.length && (
                  <div className="empty-state">
                    No reports available.
                  </div>
                )}

              </div>
            </div>
          )}

          {activeTab === "alerts" && (
            <div className="panel-content">

              <div className="panel-intro">
                <div>
                  <div className="eyebrow">EVENT DETECTION</div>
                  <h2>Alert stream</h2>
                </div>

                <span className="count-pill">
                  {alerts.length} EVENTS
                </span>
              </div>

              <div className="feed-list">

                {alerts.map(alert => (
                  <div className="alert-item" key={alert.id}>
                    <div className="alert-icon">
                      <Zap size={15}/>
                    </div>

                    <div>
                      <h3>{alert.title}</h3>
                      <p>{alert.detail}</p>

                      <time>
                        {alert.time
                          ? new Date(alert.time).toLocaleString()
                          : "Time unavailable"}
                      </time>
                    </div>
                  </div>
                ))}

                {!alerts.length && (
                  <div className="empty-state">
                    No alerts available.
                  </div>
                )}

              </div>
            </div>
          )}

          {activeTab === "sources" && (
            <div className="panel-content">

              <div className="panel-intro">
                <div>
                  <div className="eyebrow">CONNECTIVITY</div>
                  <h2>Data sources</h2>
                </div>
              </div>

              {error && (
                <div className="inline-warning">{error}</div>
              )}

              <div className="source-list">

                {Object.entries(serviceStatus).map(
                  ([name, status]) => (
                    <div className="source-row" key={name}>
                      <div>
                        <strong>{name}</strong>
                        <p>{status.detail}</p>
                      </div>

                      <span className={`source-state ${status.status}`}>
                        {status.status.replaceAll("_", " ")}
                      </span>
                    </div>
                  )
                )}

              </div>

              <div className="source-note">
                <strong>Live layer diagnostics</strong>

                <p>
                  Aircraft: {flights.length} received
                  {dropped.flights
                    ? `, ${dropped.flights} without valid position`
                    : ""}
                  {flightInfo ? ` — ${flightInfo}` : ""}
                </p>

                <p>
                  Vessels: {vessels.length} received
                  {dropped.vessels
                    ? `, ${dropped.vessels} without valid position`
                    : ""}
                  {vesselInfo ? ` — ${vesselInfo}` : ""}
                </p>
              </div>

              <div className="source-note">
                <strong>RSS source health</strong>

                {sourceStatus.map(source => (
                  <p key={source.source}>
                    {source.source}: {source.status}
                    {source.error ? ` — ${source.error}` : ""}
                  </p>
                ))}
              </div>

              <div className="source-note">
                <strong>Data integrity</strong>
                <p>
                  Unavailable providers are not replaced with
                  invented live positions.
                </p>
              </div>

              <div className="source-manager">

                <h3>Add news agency</h3>

                <input
                  value={newSourceName}
                  onChange={event => setNewSourceName(event.target.value)}
                  placeholder="Agency name"
                />

                <input
                  value={newSourceUrl}
                  onChange={event => setNewSourceUrl(event.target.value)}
                  placeholder="RSS / Atom URL"
                />

                <select
                  value={newSourceCategory}
                  onChange={event => setNewSourceCategory(event.target.value)}
                >
                  <option value="world">World</option>
                  <option value="conflict">Conflict</option>
                  <option value="protest">Protest</option>
                  <option value="technology">Technology</option>
                  <option value="finance">Finance</option>
                </select>

                <button
                  className="primary-action"
                  onClick={() => void addNewsSource()}
                  disabled={!newSourceName.trim() || !newSourceUrl.trim()}
                >
                  <Plus size={15}/>
                  Add source
                </button>

                {sourceMessage && (
                  <p className="source-message">{sourceMessage}</p>
                )}

                <h3>Custom sources</h3>

                {sources
                  .filter(source => source.custom)
                  .map(source => (
                    <div className="custom-source" key={source.url}>
                      <span>{source.name}</span>

                      <button
                        onClick={() => void removeNewsSource(source.url)}
                        title="Remove source"
                      >
                        <Trash2 size={15}/>
                      </button>
                    </div>
                  ))}

              </div>

            </div>
          )}

          {activeTab === "markets" && (
            <div className="panel-content markets-panel">

              <div className="panel-intro">
                <div>
                  <div className="eyebrow">GLOBAL FINANCIAL DATA</div>
                  <h2>Market monitor</h2>
                </div>

                <button
                  className="market-refresh"
                  onClick={() => void loadMarkets()}
                  title="Refresh market data"
                >
                  <RefreshCw
                    size={16}
                    className={marketLoading ? "spin" : ""}
                  />
                </button>
              </div>

              <div className="market-summary">
                <div className="market-summary-icon">
                  <ChartNoAxesCombined size={20}/>
                </div>

                <div>
                  <strong>{marketItems.length}</strong>
                  <span>MARKET INSTRUMENTS</span>
                </div>

                <div className="market-summary-status">
                  <span className="live-dot"/>
                  {marketLoading ? "UPDATING" : "DATA FEED"}
                </div>
              </div>

              <div className="market-filters">
                {marketFilters.map(filter => (
                  <button
                    key={filter.id}
                    className={marketFilter === filter.id ? "active" : ""}
                    onClick={() => setMarketFilter(filter.id)}
                  >
                    {filter.label}
                    <span>{marketCounts[filter.id]}</span>
                  </button>
                ))}
              </div>

              {marketError && (
                <div className="inline-warning">
                  {marketError}
                </div>
              )}

              <div className="market-list">

                {filteredMarkets.map((item, index) => (
                  <div
                    className="market-item"
                    key={`${item.symbol}-${index}`}
                  >
                    <div className="market-item-main">
                      <div className={`market-icon ${item.category}`}>
                        {item.category === "crypto" ? (
                          <Coins size={17}/>
                        ) : item.category === "forex" ? (
                          <CircleDollarSign size={17}/>
                        ) : (
                          <TrendingUp size={17}/>
                        )}
                      </div>

                      <div className="market-name">
                        <strong>{item.symbol}</strong>
                        <span>{item.name}</span>
                      </div>
                    </div>

                    <div className="market-item-values">
                      <strong>
                        {formatPrice(item.price, item.currency)}
                      </strong>

                      <span
                        className={
                          item.change24h === undefined ||
                          item.change24h === null
                            ? ""
                            : item.change24h >= 0
                              ? "positive"
                              : "negative"
                        }
                      >
                        {item.change24h !== undefined &&
                        item.change24h !== null ? (
                          item.change24h >= 0
                            ? <TrendingUp size={12}/>
                            : <TrendingDown size={12}/>
                        ) : null}

                        {formatChange(item.change24h)}
                      </span>
                    </div>

                    <div className="market-item-meta">
                      <span>{item.category.toUpperCase()}</span>
                      <span>{item.source}</span>
                    </div>
                  </div>
                ))}

                {!filteredMarkets.length && (
                  <div className="empty-state">
                    {marketLoading
                      ? "Loading market data..."
                      : "No market data available for this category."}
                  </div>
                )}

              </div>

              <div className="market-provider-list">
                <div className="eyebrow">PROVIDER STATUS</div>

                {Object.entries(marketServices).map(
                  ([name, status]) => (
                    <div className="market-provider" key={name}>
                      <span>{name}</span>

                      <span className={`source-state ${status.status}`}>
                        {status.status.replaceAll("_", " ")}
                      </span>
                    </div>
                  )
                )}
              </div>

              <div className="source-note market-disclaimer">
                <strong>Market data notes</strong>
                <p>
                  Cryptocurrency prices are sourced from Binance.
                  Forex values are daily reference rates, not live
                  trading quotes. Commodity availability depends on
                  the configured provider.
                </p>
                <p>
                  This dashboard displays market data and does not
                  provide investment recommendations.
                </p>
              </div>

            </div>
          )}

          {activeTab === "settings" && (
            <div className="panel-content">

              <div className="panel-intro">
                <div>
                  <div className="eyebrow">INTERFACE CONTROL</div>
                  <h2>Appearance</h2>
                </div>
              </div>

              <div className="theme-list">

                {(Object.keys(defaultTheme) as (keyof Theme)[]).map(key => (
                  <label className="theme-row" key={key}>
                    <span>{key.replace(/([A-Z])/g, " $1")}</span>

                    <input
                      type="color"
                      value={theme[key]}
                      onChange={event => setColor(key, event.target.value)}
                    />
                  </label>
                ))}

                <button
                  className="primary-action"
                  onClick={() => setTheme(defaultTheme)}
                >
                  Reset theme
                </button>

              </div>

              <div className="source-note">
                Theme settings are saved locally in this browser.
              </div>

            </div>
          )}

          <div className="panel-bottom">
            <span className="tiny-led"/>
            PUBLIC DATA SOURCES
            <span>·</span>
            {busy || marketLoading ? "UPDATING" : "MONITORING"}
          </div>

        </aside>

      </main>

      <div className="breaking-ticker">

        <button
          className="ticker-label"
          onClick={() => setTickerPaused(!tickerPaused)}
        >
          <span className="ticker-live"/>
          BREAKING NEWS
          {tickerPaused ? " ▶" : " ❚❚"}
        </button>

        <div className="ticker-viewport">
          {tickerItems.length ? (
            <div
              className={`ticker-track ${tickerPaused ? "paused" : ""}`}
              style={{
                animationDuration: `${Math.max(40, tickerItems.length * 7)}s`
              }}
            >
              {[...tickerItems, ...tickerItems].map((item, index) => (
                <button
                  className="ticker-item"
                  key={`${item.id}-${index}`}
                  onClick={() => setSelected(item)}
                >
                  <strong>{item.source}</strong>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="ticker-empty">
              Waiting for news feeds...
            </span>
          )}
        </div>

      </div>

    </div>
  );
}

function Layer({
  icon,
  name,
  detail,
  checked,
  onClick,
  color
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  checked: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      className="layer-row"
      onClick={onClick}
      aria-pressed={checked}
    >
      <span className={`layer-icon ${color}`}>
        {icon}
      </span>

      <span className="layer-copy">
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>

      <span className={`toggle ${checked ? "on" : ""}`}>
        <i/>
      </span>
    </button>
  );
}
