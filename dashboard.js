/* ============================================================
   RESQ — COMMAND DASHBOARD ORCHESTRATION & MAPBOX 3D ENGINE
   Full backend integration, Mapbox GL JS 3D, Real-time WebSockets,
   interactive origin selection, OSM infrastructure, and cascading failure telemetry.
============================================================ */

(function () {
    "use strict";

    /* ============================================================
       1. BOOTSTRAP & STATE VALIDATION
    ============================================================ */

    const rawSimulation = localStorage.getItem("resqSimulation");
    if (!rawSimulation) {
        window.location.href = "index.html";
        return;
    }

    let simulationConfig;
    try {
        simulationConfig = JSON.parse(rawSimulation);
    } catch (e) {
        console.error("Malformed simulation configuration in localStorage", e);
        window.location.href = "index.html";
        return;
    }

    const rules = window.DISASTER_RULES || {
        properties: {},
        impactModels: {},
        palettes: {},
        getCityType: () => "coastal",
    };

    const api = window.RESQ_API;
    const engine = typeof window.SimulationEngine !== "undefined" ? new window.SimulationEngine(simulationConfig) : null;
    if (engine) window.engine = engine;

    // Active runtime state
    let scenarioId = simulationConfig.scenarioId || null;
    let simulationId = simulationConfig.simulationId || null;
    let wsConnection = null;
    let isSelectingOrigin = false;
    let originMarker = null;
    let cycloneSwirlMarker = null;
    let currentOrigin = {
        latitude: Number(simulationConfig.latitude) || 13.0827,
        longitude: Number(simulationConfig.longitude) || 80.2707
    };
    let currentProperties = {};
    let isPaused = false;
    let currentSpeed = 1;
    let isSimulationStarted = false;
    let previousAffectedPopulation = null;
    let maxCasualtiesSeen = 0;

    /* ============================================================
       2. DOM REFERENCES
    ============================================================ */

    // Navbar
    const scenarioLocation = document.getElementById("scenarioLocation");
    const scenarioDisaster = document.getElementById("scenarioDisaster");
    const scenarioSeverityTag = document.getElementById("scenarioSeverityTag");
    const btnStartSim = document.getElementById("btnStartSim");
    const btnPlayPause = document.getElementById("btnPlayPause");
    const playPauseIcon = document.getElementById("playPauseIcon");
    const playPauseText = document.getElementById("playPauseText");
    const btnReset = document.getElementById("btnReset");
    const speedButtons = document.querySelectorAll(".speed-btn");
    const themeToggle = document.getElementById("themeToggle");

    // Overview Counters & AI
    const counterAffected = document.getElementById("counterAffected");
    const deltaAffected = document.getElementById("deltaAffected");
    const counterCasualties = document.getElementById("counterCasualties");
    const counterHospAvail = document.getElementById("counterHospAvail");
    const counterHospFull = document.getElementById("counterHospFull");
    const hospCapacityFill = document.getElementById("hospCapacityFill");
    const counterBlockedRoads = document.getElementById("counterBlockedRoads");
    const counterShelters = document.getElementById("counterShelters");
    const counterOutages = document.getElementById("counterOutages");
    const aiSummaryText = document.getElementById("aiSummaryText");
    const aiGuidanceText = document.getElementById("aiGuidanceText");
    const aiTimestamp = document.getElementById("aiTimestamp");

    // Origin Selection
    const btnSetOrigin = document.getElementById("btnSetOrigin");
    const btnSetOriginText = document.getElementById("btnSetOriginText");
    const originCoordsVal = document.getElementById("originCoordsVal");
    const originSelectionHint = document.getElementById("originSelectionHint");

    // Properties Panel
    const propertiesGrid = document.getElementById("propertiesGrid");
    const propsDisasterSubtitle = document.getElementById("propsDisasterSubtitle");
    const sevValueBadge = document.getElementById("sevValueBadge");
    const btnEscalate = document.getElementById("btnEscalate");
    const btnMitigate = document.getElementById("btnMitigate");

    // Map Telemetry
    const mapContainer = document.getElementById("mapContainer");
    const mapCoordsReadout = document.getElementById("mapCoordsReadout");
    const mapZoomReadout = document.getElementById("mapZoomReadout");
    const mapRadiusReadout = document.getElementById("mapRadiusReadout");
    const mapHudLayers = document.getElementById("mapHudLayers");

    // Splitters & Workspace
    const workspaceTop = document.getElementById("workspaceTop");
    const mapPanel = document.getElementById("mapPanel");
    const overviewPanel = document.getElementById("overviewPanel");
    const aiPanel = document.getElementById("aiPanel");
    const propertiesPanel = document.getElementById("propertiesPanel");
    const resizerV1 = document.getElementById("resizerV1") || document.getElementById("resizerV");
    const resizerV2 = document.getElementById("resizerV2");
    const resizerH = document.getElementById("resizerH");

    // Mobile Tabs
    const tabMapBtn = document.getElementById("tabMapBtn");
    const tabPropsBtn = document.getElementById("tabPropsBtn");

    /* ============================================================
       3. THEME TOGGLE & SYNCHRONIZATION
    ============================================================ */

    function isLightMode() {
        return document.documentElement.classList.contains("light-mode") || document.body.classList.contains("light-mode");
    }

    function syncTheme() {
        const light = isLightMode();
        if (light) {
            document.documentElement.classList.add("light-mode");
            document.body.classList.add("light-mode");
        }
        themeToggle?.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
        themeToggle?.setAttribute("title", light ? "Switch to dark mode" : "Switch to light mode");
    }

    themeToggle?.addEventListener("click", () => {
        const willBeLight = !isLightMode();
        document.documentElement.classList.toggle("light-mode", willBeLight);
        document.body.classList.toggle("light-mode", willBeLight);
        localStorage.setItem("resq-theme", willBeLight ? "light" : "dark");
        syncTheme();
        updateMapThemeStyle();
    });

    syncTheme();

    /* ============================================================
       4. NAVBAR SCENARIO SETUP
    ============================================================ */

    scenarioLocation.textContent = `${simulationConfig.city}, ${simulationConfig.country}`;
    scenarioDisaster.textContent = simulationConfig.disaster.toUpperCase();
    updateOriginReadout(currentOrigin.latitude, currentOrigin.longitude);

    function updateOriginReadout(lat, lng) {
        const latNum = Number(lat);
        const lngNum = Number(lng);
        const latDir = latNum >= 0 ? "N" : "S";
        const lngDir = lngNum >= 0 ? "E" : "W";
        const readout = `${Math.abs(latNum).toFixed(4)}° ${latDir} / ${Math.abs(lngNum).toFixed(4)}° ${lngDir}`;
        if (mapCoordsReadout) mapCoordsReadout.textContent = readout;
        if (originCoordsVal) {
            originCoordsVal.textContent = readout;
            originCoordsVal.classList.remove("coords-established-flash");
            void originCoordsVal.offsetWidth;
            originCoordsVal.classList.add("coords-established-flash");
        }
    }

    /* ============================================================
       5. OPENFREEMAP & MAPLIBRE GL JS 3D (45° PITCH - ZERO API KEY)
    ============================================================ */

    let map = null;
    let poiMarkers = [];
    let latestSimulationState = null;
    let cachedCityData = null;
    let evacRouteEventsAttached = false;
    const layerVisibility = {
        roads: true,
        evac: true,
        hazard: true,
        hospitals: true,
        shelters: true,
        outages: true,
        origin: true,
    };

    function getTileStyle(light) {
        // 100% Free, zero-token OpenFreeMap vector styles with 3D buildings
        return light
            ? "https://tiles.openfreemap.org/styles/positron"
            : "https://tiles.openfreemap.org/styles/liberty";
    }

    async function initMap() {
        const center = [currentOrigin.longitude, currentOrigin.latitude];

        if (typeof maplibregl === "undefined") {
            console.error("MapLibre GL JS failed to load.");
            renderMapFallback(mapContainer, center);
            return;
        }

        try {
            map = new maplibregl.Map({
                container: "mapContainer",
                style: getTileStyle(isLightMode()),
                center: center,
                zoom: 13.8,
                pitch: 45, // Required 45° 3D perspective pitch
                bearing: -15,
                maxPitch: 70,
                antialias: true
            });

            // Navigation Controls (Compass + Tilt + Zoom)
            map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

            map.on("load", async () => {
                await loadStaticCityInfrastructure();
                setupDisasterLayers();
                setupOriginMarker();
                setupOriginClickInteraction();
                if (latestSimulationState) {
                    updateMapboxLayers(latestSimulationState);
                }
            });

            map.on("zoom", () => {
                if (mapZoomReadout) mapZoomReadout.textContent = map.getZoom().toFixed(2);
            });

            map.on("error", (e) => {
                console.warn("[RESQ] MapLibre/OpenFreeMap tile notice:", e);
            });

        } catch (err) {
            console.error("MapLibre initialization error:", err);
            renderMapFallback(mapContainer, center);
        }
    }

    function updateMapThemeStyle() {
        if (!map) return;
        const newStyle = getTileStyle(isLightMode());

        let reapplyDone = false;
        const reapplyMapData = async () => {
            if (reapplyDone) return;
            reapplyDone = true;
            try {
                await loadStaticCityInfrastructure();
                setupDisasterLayers();
                setupOriginMarker();
                if (latestSimulationState) {
                    updateMapboxLayers(latestSimulationState);
                } else {
                    updatePreviewHazardPolygon();
                }
            } catch (err) {
                console.warn("[RESQ] Error applying layers after theme switch:", err);
            }
        };

        // MapLibre GL JS setStyle defaults to { diff: true }, which removes custom layers
        // without emitting "style.load". Passing { diff: false } forces a full style rebuild
        // that reliably fires "style.load", while "idle" serves as a guaranteed safety fallback.
        map.once("style.load", reapplyMapData);
        map.once("idle", () => {
            if (!map.getSource("hazard-source")) {
                reapplyMapData();
            }
        });
        map.setStyle(newStyle, { diff: false });
    }

    /* ------------------------------------------------------------
       3D BUILDING LAYER EXTRUSIONS (DISABLED PER USER REQUEST)
    ------------------------------------------------------------ */
    function setup3DBuildingLayer(buildingsGeoJSON) {
        // Disabled: removes artificial greyish black boxes from the map
    }

    /* ------------------------------------------------------------
       STATIC OSM CITY INFRASTRUCTURE
    ------------------------------------------------------------ */
    async function loadStaticCityInfrastructure() {
        if (!map) return;

        try {
            if (!cachedCityData) {
                cachedCityData = await api.getCityMapData(simulationConfig.city);
            }
            const cityData = cachedCityData;
            if (!cityData) return;

            // 1. Add OSM Roads baseline source
            if (!map.getSource("osm-roads-source")) {
                map.addSource("osm-roads-source", {
                    type: "geojson",
                    data: cityData.roads
                });

                map.addLayer({
                    id: "osm-roads-base",
                    source: "osm-roads-source",
                    type: "line",
                    layout: {
                        "line-join": "round",
                        "line-cap": "round"
                    },
                    paint: {
                        "line-color": isLightMode() ? "#64748b" : "#334155",
                        "line-width": isLightMode() ? 2.8 : 2.5,
                        "line-opacity": isLightMode() ? 0.75 : 0.6
                    }
                });
            } else if (map.getLayer("osm-roads-base")) {
                map.setPaintProperty("osm-roads-base", "line-color", isLightMode() ? "#64748b" : "#334155");
                map.setPaintProperty("osm-roads-base", "line-width", isLightMode() ? 2.8 : 2.5);
                map.setPaintProperty("osm-roads-base", "line-opacity", isLightMode() ? 0.75 : 0.6);
            }

            // 2. 3D Buildings from OSM disabled to remove greyish black boxes

            // 3. Spawn POI markers for Hospitals, Shelters, and Power Grid
            spawnInfrastructurePOIMarkers(cityData.pois.features);

            // Reapply pill visibility filters to newly created POI markers
            ["hospitals", "shelters", "outages"].forEach(poiKey => {
                if (layerVisibility[poiKey] === false) {
                    const targetType = poiKey === "hospitals" ? "hospital" : poiKey === "shelters" ? "shelter" : "outage";
                    poiMarkers.forEach(m => {
                        const el = m.getElement();
                        if (el && el.dataset.poiType === targetType) {
                            el.style.display = "none";
                        }
                    });
                }
            });

        } catch (err) {
            console.warn("[RESQ] Could not fetch city map infrastructure:", err);
        }
    }

    function spawnInfrastructurePOIMarkers(poiFeatures) {
        // Clear previous POI markers
        poiMarkers.forEach(m => m.remove());
        poiMarkers = [];

        poiFeatures.forEach(feat => {
            const p = feat.properties;
            const coords = feat.geometry.coordinates;

            const el = document.createElement("div");
            let icon = "📍";
            let className = "";

            if (p.type === "hospital") {
                icon = p.status === "FULL" ? "✖" : "✚";
                className = p.status === "FULL" ? "marker-hospital-full" : "marker-hospital-avail";
            } else if (p.type === "shelter") {
                icon = "⌂";
                className = "marker-shelter";
            } else if (p.type === "outage") {
                icon = "⚡";
                className = "marker-outage";
            }

            el.className = `map-marker ${className}`;
            el.dataset.poiType = p.type;
            el.dataset.poiId = p.id;
            el.innerHTML = `<span>${icon}</span>`;
            el.title = `${p.name} [${p.status || "Active"}]`;

            const popupHtml = `
                <div style="font-family: 'DM Mono', monospace; font-size: 10px; color: #111; padding: 4px;">
                    <strong>${p.name}</strong><br>
                    <span style="color: #666;">Status: ${p.status || "Operational"}</span><br>
                    <span style="font-size: 9px;">${p.beds ? `Beds: ${p.availableBeds}/${p.beds}` : p.capacity ? `Capacity: ${p.remainingCapacity}/${p.capacity}` : `Power: ${p.capacityMW} MW`}</span>
                </div>
            `;

            const popup = new maplibregl.Popup({ offset: 16, closeButton: false }).setHTML(popupHtml);

            const marker = new maplibregl.Marker({
                element: el,
                anchor: "center"
            })
                .setLngLat(coords)
                .setPopup(popup)
                .addTo(map);

            poiMarkers.push(marker);
        });
    }

    /* ------------------------------------------------------------
       DISASTER DYNAMIC LAYERS (HAZARD ENVELOPE, BLOCKED ROADS, EVAC)
    ------------------------------------------------------------ */
    function setupDisasterLayers() {
        if (!map) return;
        const light = isLightMode();
        const isTsunami = (simulationConfig.disaster || "").toLowerCase() === "tsunami";
        const isCyclone = (simulationConfig.disaster || "").toLowerCase() === "cyclone";
        const isEarthquake = (simulationConfig.disaster || "").toLowerCase() === "earthquake";
        const isFlood = (simulationConfig.disaster || "").toLowerCase() === "flood";

        // Disaster-specific color palettes:
        // - Flood & Tsunami: aquatic water blue resembling inundation/flood water
        // - Cyclone: atmospheric vortex translucent violet/purple with neon purple boundary
        // - Earthquake: multi-zone seismic colors
        // - Other: tactical high-contrast amber
        const isWaterDisaster = isTsunami || isFlood;

        const hazardFillColor = isWaterDisaster
            ? (light ? "#0284c7" : "#0284c7")
            : isCyclone
            ? (light ? "#8b5cf6" : "#7c3aed")
            : (light ? "#d97706" : "#f59e0b");
        const hazardFillOpacity = isWaterDisaster
            ? (light ? 0.40 : 0.32)
            : isCyclone
            ? (light ? 0.35 : 0.28)
            : (light ? 0.35 : 0.22);
        const hazardLineColor = isWaterDisaster
            ? (light ? "#0369a1" : "#38bdf8")
            : isCyclone
            ? (light ? "#7c3aed" : "#c084fc")
            : (light ? "#b45309" : "#f59e0b");
        const hazardLineWidth = isWaterDisaster ? (light ? 3.2 : 2.6) : isCyclone ? (light ? 3.2 : 2.8) : (light ? 3.0 : 2.0);
        const hazardDashArray = isTsunami ? [4, 1] : isFlood ? [3, 2] : isCyclone ? [2, 2] : [3, 2];

        // Update Legend Pill Indicator
        const legendHazardInd = document.getElementById("legendHazardIndicator");
        const legendHazardTxt = document.getElementById("legendHazardText");
        if (legendHazardInd) {
            legendHazardInd.classList.remove("yellow-box", "blue-box", "purple-box", "quake-box");
            if (isTsunami) {
                legendHazardInd.classList.add("blue-box");
                if (legendHazardTxt) legendHazardTxt.textContent = "TSUNAMI SURGE";
            } else if (isFlood) {
                legendHazardInd.classList.add("blue-box");
                if (legendHazardTxt) legendHazardTxt.textContent = "FLOOD WATER";
            } else if (isCyclone) {
                legendHazardInd.classList.add("purple-box");
                if (legendHazardTxt) legendHazardTxt.textContent = "CYCLONE SWATH";
            } else if (isEarthquake) {
                legendHazardInd.classList.add("quake-box");
                if (legendHazardTxt) legendHazardTxt.textContent = "SEISMIC ZONES";
            } else {
                legendHazardInd.classList.add("yellow-box");
                if (legendHazardTxt) legendHazardTxt.textContent = "HAZARD ZONE";
            }
        }

        // 1. Hazard Polygon Overlay (Data-driven for multi-colored concentric earthquake zones)
        if (!map.getSource("hazard-source")) {
            map.addSource("hazard-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            map.addLayer({
                id: "hazard-fill",
                source: "hazard-source",
                type: "fill",
                paint: {
                    "fill-color": ["coalesce", ["get", "fillColor"], hazardFillColor],
                    "fill-opacity": ["coalesce", ["get", "fillOpacity"], hazardFillOpacity]
                }
            });

            map.addLayer({
                id: "hazard-line",
                source: "hazard-source",
                type: "line",
                paint: {
                    "line-color": ["coalesce", ["get", "strokeColor"], hazardLineColor],
                    "line-width": ["coalesce", ["get", "lineWidth"], hazardLineWidth],
                    "line-dasharray": hazardDashArray
                }
            });
        } else {
            if (map.getLayer("hazard-fill")) {
                map.setPaintProperty("hazard-fill", "fill-color", ["coalesce", ["get", "fillColor"], hazardFillColor]);
                map.setPaintProperty("hazard-fill", "fill-opacity", ["coalesce", ["get", "fillOpacity"], hazardFillOpacity]);
            }
            if (map.getLayer("hazard-line")) {
                map.setPaintProperty("hazard-line", "line-color", ["coalesce", ["get", "strokeColor"], hazardLineColor]);
                map.setPaintProperty("hazard-line", "line-width", ["coalesce", ["get", "lineWidth"], hazardLineWidth]);
                map.setPaintProperty("hazard-line", "line-dasharray", hazardDashArray);
            }
        }

        // 2. Blocked Roads (Dual-layer: High-contrast dark casing + vivid red core)
        if (!map.getSource("blocked-roads-source")) {
            map.addSource("blocked-roads-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            // Outer high-contrast casing
            map.addLayer({
                id: "blocked-roads-casing",
                source: "blocked-roads-source",
                type: "line",
                layout: {
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": light ? "#450a0a" : "#1a0202",
                    "line-width": 8.0,
                    "line-opacity": 0.85
                }
            });

            // Inner vivid red core
            map.addLayer({
                id: "blocked-roads-line",
                source: "blocked-roads-source",
                type: "line",
                layout: {
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": light ? "#dc2626" : "#ef4444",
                    "line-width": 5.0,
                    "line-opacity": 1.0
                }
            });
        }

        // 3. Evacuation Routes (Dual-layer: High-contrast dark casing + vivid emerald core)
        if (!map.getSource("evac-routes-source")) {
            map.addSource("evac-routes-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            // Outer high-contrast navy casing
            map.addLayer({
                id: "evac-routes-casing",
                source: "evac-routes-source",
                type: "line",
                layout: {
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": light ? "#0369a1" : "#082f49",
                    "line-width": 8.0,
                    "line-opacity": 0.90
                }
            });

            // Inner vivid electric blue / cyan core
            map.addLayer({
                id: "evac-routes-line",
                source: "evac-routes-source",
                type: "line",
                layout: {
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": light ? "#0284c7" : "#38bdf8",
                    "line-width": 5.0,
                    "line-opacity": 1.0
                }
            });

            // Interactive inspection on evacuation corridors (attached once to prevent duplicates)
            if (!evacRouteEventsAttached) {
                evacRouteEventsAttached = true;
                map.on("click", "evac-routes-line", (e) => {
                    const f = e.features && e.features[0];
                    if (!f) return;
                    const props = f.properties || {};
                    const fromZone = props.fromZone ? `Threat Zone: <b>${props.fromZone}</b><br>` : "";
                    const toShelter = props.toShelter ? `Safe Destination: <b>${props.toShelter}</b><br>` : "";
                    const dist = props.distanceKm ? `Corridor Distance: <b>${props.distanceKm} km</b><br>` : "";
                    new maplibregl.Popup({ offset: [0, -10], closeButton: true })
                        .setLngLat(e.lngLat)
                        .setHTML(`
                            <div style="font-family: 'DM Mono', monospace; font-size: 11px; padding: 6px 8px; color: #0284c7; min-width: 190px;">
                                <div style="font-weight: 700; font-size: 12px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                                    <span>🛡️</span> <span>EVACUATION CORRIDOR</span>
                                </div>
                                <div style="color: #475569; line-height: 1.5; font-size: 10px;">
                                    ${fromZone}${toShelter}${dist}
                                    Status: <span style="color: #10b981; font-weight: 700;">ACTIVE ESCAPE ROUTE</span>
                                </div>
                            </div>
                        `)
                        .addTo(map);
                });

                map.on("mouseenter", "evac-routes-line", () => {
                    map.getCanvas().style.cursor = "pointer";
                });
                map.on("mouseleave", "evac-routes-line", () => {
                    map.getCanvas().style.cursor = "";
                });
            }
        }

        // Reapply current active simulation data or initial preview
        if (latestSimulationState) {
            updateMapboxLayers(latestSimulationState);
        } else {
            updatePreviewHazardPolygon();
            if (map.getSource("evac-routes-source")) {
                map.getSource("evac-routes-source").setData({ type: "FeatureCollection", features: [] });
            }
            if (map.getSource("blocked-roads-source")) {
                map.getSource("blocked-roads-source").setData({ type: "FeatureCollection", features: [] });
            }
        }

        // Restore pill toggle visibility states for newly added layers
        if (!layerVisibility.roads) {
            if (map.getLayer("blocked-roads-casing")) map.setLayoutProperty("blocked-roads-casing", "visibility", "none");
            if (map.getLayer("blocked-roads-line")) map.setLayoutProperty("blocked-roads-line", "visibility", "none");
        }
        if (!layerVisibility.evac) {
            if (map.getLayer("evac-routes-glow")) map.setLayoutProperty("evac-routes-glow", "visibility", "none");
            if (map.getLayer("evac-routes-casing")) map.setLayoutProperty("evac-routes-casing", "visibility", "none");
            if (map.getLayer("evac-routes-line")) map.setLayoutProperty("evac-routes-line", "visibility", "none");
        }
        if (!layerVisibility.hazard) {
            if (map.getLayer("hazard-fill")) map.setLayoutProperty("hazard-fill", "visibility", "none");
            if (map.getLayer("hazard-line")) map.setLayoutProperty("hazard-line", "visibility", "none");
        }
    }

    /* ------------------------------------------------------------
       HAZARD ENVELOPE PREVIEW GENERATOR
    ------------------------------------------------------------ */
    function createTsunamiOceanicPolygon(targetLng, targetLat, progress = 1.0, numSteps = 36) {
        // Ocean boundary in Bay of Bengal (east of Chennai)
        const oceanLng = Math.max(80.40, targetLng + 0.10);
        const latSpan = 0.24;
        const clampedProg = Math.max(0.05, Math.min(1.0, progress));

        const coords = [];
        // 1. Northeast corner anchored in ocean
        coords.push([Number(oceanLng.toFixed(6)), Number((targetLat + latSpan).toFixed(6))]);
        // 2. Southeast corner anchored in ocean
        coords.push([Number(oceanLng.toFixed(6)), Number((targetLat - latSpan).toFixed(6))]);

        // 3. Wave surge front advancing westward from South to North
        for (let i = 0; i <= numSteps; i++) {
            const y = -1.0 + 2.0 * i / numSteps;
            const ptLat = Number((targetLat + y * latSpan).toFixed(6));
            // Parabolic apex at y=0 (targetLat) with subtle coastal wave perturbation
            const inlandFactor = Math.max(0.12, (1.0 - 0.38 * (y * y)) + 0.012 * Math.sin(y * 5.0 * Math.PI));
            const ptLng = Number((oceanLng - (oceanLng - targetLng) * clampedProg * inlandFactor).toFixed(6));
            coords.push([ptLng, ptLat]);
        }

        // 4. Close polygon back to first corner
        coords.push(coords[0]);
        return coords;
    }

    function createHazardCirclePolygon(centerLng, centerLat, radiusKm = 4.2, numPoints = 36) {
        const coords = [];
        const latDegPerKm = 1.0 / 110.574;
        const lonDegPerKm = 1.0 / (111.320 * Math.cos(centerLat * Math.PI / 180.0));

        for (let i = 0; i <= numPoints; i++) {
            const angle = (i / numPoints) * 2.0 * Math.PI;
            const variance = 1.0 + 0.10 * Math.sin(angle * 3.0) + 0.06 * Math.cos(angle * 2.0);
            const r = radiusKm * variance;
            const ptLat = centerLat + (Math.sin(angle) * r * latDegPerKm);
            const ptLon = centerLng + (Math.cos(angle) * r * lonDegPerKm);
            coords.push([Number(ptLon.toFixed(6)), Number(ptLat.toFixed(6))]);
        }
        return coords;
    }

    function createEarthquakeConcentricFeatures(centerLng, centerLat, radiusKm = 4.2) {
        // 4 concentric zones matching user requirement & backend model:
        // Zone I: Outer / Very Low - Yellow (#facc15), 100% radius
        // Zone II: Moderate / Low - Light Orange (#fb923c), 70% radius
        // Zone III: Strong / Mid - Dark Orange (#ea580c), 45% radius
        // Zone IV: Epicenter Core / High - Red (#ef4444), 20% radius
        const zoneConfigs = [
            {
                name: "Zone I: Very Low (Perceptible Tremor)",
                severity: "VERY_LOW",
                factor: 1.0,
                fillColor: "#facc15",
                strokeColor: "#eab308",
                fillOpacity: 0.22,
                lineWidth: 1.8
            },
            {
                name: "Zone II: Low (Moderate Shaking)",
                severity: "LOW",
                factor: 0.70,
                fillColor: "#fb923c",
                strokeColor: "#f97316",
                fillOpacity: 0.28,
                lineWidth: 2.0
            },
            {
                name: "Zone III: Mid (Strong Shaking)",
                severity: "MID",
                factor: 0.45,
                fillColor: "#ea580c",
                strokeColor: "#c2410c",
                fillOpacity: 0.35,
                lineWidth: 2.2
            },
            {
                name: "Zone IV: High (Severe Epicenter Shaking)",
                severity: "HIGH",
                factor: 0.20,
                fillColor: "#ef4444",
                strokeColor: "#b91c1c",
                fillOpacity: 0.45,
                lineWidth: 2.6
            }
        ];

        return zoneConfigs.map(cfg => {
            const r = Math.max(0.2, radiusKm * cfg.factor);
            const coords = createHazardCirclePolygon(centerLng, centerLat, r, 36);
            return {
                type: "Feature",
                properties: {
                    name: cfg.name,
                    severity: cfg.severity,
                    fillColor: cfg.fillColor,
                    strokeColor: cfg.strokeColor,
                    fillOpacity: cfg.fillOpacity,
                    lineWidth: cfg.lineWidth
                },
                geometry: {
                    type: "Polygon",
                    coordinates: [coords]
                }
            };
        });
    }

    function calculateDynamicCycloneTrack(originLat, originLng, cityLat = 13.0827, cityLng = 80.2707, elapsedSeconds = 0.0, speedDeg = 0.0028) {
        const totalSteps = Math.max(0, Math.floor(elapsedSeconds));
        const track = [];
        track.push([Number(originLng.toFixed(6)), Number(originLat.toFixed(6))]);
        if (totalSteps <= 0) return track;

        const dx = cityLng - originLng;
        const dy = cityLat - originLat;
        const dist = Math.hypot(dx, dy);

        const baseAngle = dist > 0.005 ? Math.atan2(dy, dx) : (160 * Math.PI / 180);
        const tCenter = Math.max(20.0, (dist > 0.005 ? dist : 0.10) / speedDeg);

        let currAngle = baseAngle;
        let cLng = originLng;
        let cLat = originLat;

        for (let step = 1; step <= totalSteps; step++) {
            const s = step;
            const progressPastCenter = (s - tCenter * 0.75) / (tCenter * 0.5);
            const turnWeight = 1.0 / (1.0 + Math.exp(-2.5 * progressPastCenter));
            const turnRate = 0.024 * turnWeight;
            currAngle -= turnRate;
            cLng += speedDeg * Math.cos(currAngle);
            cLat += speedDeg * Math.sin(currAngle);
            track.push([Number(cLng.toFixed(6)), Number(cLat.toFixed(6))]);
        }
        return track;
    }

    function calculateCycloneTrack(originLat, originLng, progress = 1.0, totalSteps = 32) {
        const elapsed = progress * 60.0;
        return calculateDynamicCycloneTrack(originLat, originLng, 13.0827, 80.2707, elapsed);
    }

    function getCycloneCategory(windSpeed, stormSurge) {
        const wind = Number(windSpeed) || 175;
        const surge = Number(stormSurge) || 3.2;
        if (wind >= 220 || surge >= 5.5) {
            return { category: "CAT 5", name: "SUPER CYCLONIC STORM", tag: "CAT 5 · SUPER CYCLONE" };
        } else if (wind >= 178 || surge >= 4.0) {
            return { category: "CAT 4", name: "EXTREMELY SEVERE CYCLONIC STORM", tag: "CAT 4 · EXTREME" };
        } else if (wind >= 154 || surge >= 2.8) {
            return { category: "CAT 3", name: "VERY SEVERE CYCLONIC STORM", tag: "CAT 3 · VERY SEVERE" };
        } else if (wind >= 119 || surge >= 1.8) {
            return { category: "CAT 2", name: "SEVERE CYCLONIC STORM", tag: "CAT 2 · SEVERE" };
        } else if (wind >= 90 || surge >= 1.2) {
            return { category: "CAT 1", name: "CYCLONIC STORM", tag: "CAT 1 · CYCLONIC" };
        } else {
            return { category: "TROPICAL STORM", name: "DEEP DEPRESSION", tag: "TROPICAL STORM" };
        }
    }

    function createSweptSwathPolygon(trackPoints, radiusKm = 5.0, numCapPts = 8) {
        if (!trackPoints || trackPoints.length === 0) return [];
        if (trackPoints.length === 1) {
            return createHazardCirclePolygon(trackPoints[0][0], trackPoints[0][1], radiusKm, 24);
        }

        const leftPts = [];
        const rightPts = [];

        for (let i = 0; i < trackPoints.length; i++) {
            const [cLng, cLat] = trackPoints[i];
            const latDeg = radiusKm / 110.574;
            const lonDeg = radiusKm / (111.320 * Math.cos(cLat * Math.PI / 180.0));

            let dx, dy;
            if (i === 0) {
                dx = (trackPoints[1][0] - cLng) / lonDeg;
                dy = (trackPoints[1][1] - cLat) / latDeg;
            } else if (i === trackPoints.length - 1) {
                dx = (cLng - trackPoints[i - 1][0]) / lonDeg;
                dy = (cLat - trackPoints[i - 1][1]) / latDeg;
            } else {
                dx = (trackPoints[i + 1][0] - trackPoints[i - 1][0]) / lonDeg;
                dy = (trackPoints[i + 1][1] - trackPoints[i - 1][1]) / latDeg;
            }

            const length = Math.hypot(dx, dy) || 1.0;
            const nx = -dy / length;
            const ny = dx / length;

            leftPts.push([Number((cLng + nx * lonDeg).toFixed(6)), Number((cLat + ny * latDeg).toFixed(6))]);
            rightPts.push([Number((cLng - nx * lonDeg).toFixed(6)), Number((cLat - ny * latDeg).toFixed(6))]);
        }

        const coords = [...leftPts];

        // Semicircular cap at active eye (end)
        const [endLng, endLat] = trackPoints[trackPoints.length - 1];
        const endLatDeg = radiusKm / 110.574;
        const endLonDeg = radiusKm / (111.320 * Math.cos(endLat * Math.PI / 180.0));
        let startAng = Math.atan2((leftPts[leftPts.length - 1][1] - endLat) / endLatDeg, (leftPts[leftPts.length - 1][0] - endLng) / endLonDeg);
        let endAng = Math.atan2((rightPts[rightPts.length - 1][1] - endLat) / endLatDeg, (rightPts[rightPts.length - 1][0] - endLng) / endLonDeg);
        if (endAng > startAng) {
            endAng -= 2.0 * Math.PI;
        }
        for (let j = 1; j < numCapPts; j++) {
            const a = startAng + (endAng - startAng) * (j / numCapPts);
            coords.push([Number((endLng + Math.cos(a) * endLonDeg).toFixed(6)), Number((endLat + Math.sin(a) * endLatDeg).toFixed(6))]);
        }

        coords.push(...[...rightPts].reverse());

        // Semicircular cap at track start
        const [sLng, sLat] = trackPoints[0];
        const sLatDeg = radiusKm / 110.574;
        const sLonDeg = radiusKm / (111.320 * Math.cos(sLat * Math.PI / 180.0));
        let startAngS = Math.atan2((rightPts[0][1] - sLat) / sLatDeg, (rightPts[0][0] - sLng) / sLonDeg);
        let endAngS = Math.atan2((leftPts[0][1] - sLat) / sLatDeg, (leftPts[0][0] - sLng) / sLonDeg);
        if (endAngS > startAngS) {
            endAngS -= 2.0 * Math.PI;
        }
        for (let j = 1; j < numCapPts; j++) {
            const a = startAngS + (endAngS - startAngS) * (j / numCapPts);
            coords.push([Number((sLng + Math.cos(a) * sLonDeg).toFixed(6)), Number((sLat + Math.sin(a) * sLatDeg).toFixed(6))]);
        }

        coords.push(coords[0]);
        return coords;
    }

    function updatePreviewHazardPolygon() {
        if (!map || !map.getSource("hazard-source")) return;
        const light = isLightMode();
        const isTsunami = (simulationConfig.disaster || "").toLowerCase() === "tsunami";
        const isCyclone = (simulationConfig.disaster || "").toLowerCase() === "cyclone";
        const isEarthquake = (simulationConfig.disaster || "").toLowerCase() === "earthquake";
        const isFlood = (simulationConfig.disaster || "").toLowerCase() === "flood";

        // Cyclone: Before starting the simulation, the cyclone does not exist on the map.
        // Show zero swath boundaries and zero swirl markers. Only origin pin is shown.
        if (isCyclone) {
            removeCycloneSwirlMarker();
            map.getSource("hazard-source").setData({
                type: "FeatureCollection",
                features: []
            });
            if (mapRadiusReadout) {
                const wind = Number(currentProperties.windSpeed) || 175;
                const surge = Number(currentProperties.stormSurge) || 3.2;
                const nw = Math.max(0, Math.min(1, (wind - 70) / 210.0));
                const ns = Math.max(0, Math.min(1, (surge - 0.5) / 7.5));
                const radius = 1.0 + nw * 2.0 + ns * 1.0;
                mapRadiusReadout.textContent = `${radius.toFixed(1)} km Gale Swath`;
            }
            return;
        }

        if (isEarthquake) {
            const depth = Number(currentProperties.depth) || 12.0;
            const maxRadius = 3.5 + (35.0 / Math.max(5.0, depth));
            const eqFeatures = createEarthquakeConcentricFeatures(currentOrigin.longitude, currentOrigin.latitude, maxRadius);
            map.getSource("hazard-source").setData({
                type: "FeatureCollection",
                features: eqFeatures
            });
            if (mapRadiusReadout) {
                mapRadiusReadout.textContent = `${maxRadius.toFixed(1)} km (4 Seismic Zones)`;
            }
            return;
        }

        let polyCoords;
        if (isTsunami) {
            polyCoords = createTsunamiOceanicPolygon(currentOrigin.longitude, currentOrigin.latitude, 1.0);
        } else {
            const radius = Number(simulationConfig.hazardRadius) || 4.2;
            polyCoords = createHazardCirclePolygon(currentOrigin.longitude, currentOrigin.latitude, radius);
        }

        map.getSource("hazard-source").setData({
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                properties: { 
                    name: isTsunami ? "Active Tsunami Inundation Surge" : isFlood ? "Active Flood Water Inundation" : "Active Impact Hazard Zone",
                    fillColor: isFlood ? (light ? "#0284c7" : "#0284c7") : undefined,
                    strokeColor: isFlood ? (light ? "#0369a1" : "#38bdf8") : undefined,
                    fillOpacity: isFlood ? (light ? 0.40 : 0.32) : undefined,
                    lineWidth: isFlood ? (light ? 3.2 : 2.6) : undefined
                },
                geometry: {
                    type: "Polygon",
                    coordinates: [polyCoords]
                }
            }]
        });
        if (mapRadiusReadout) {
            if (isTsunami) {
                mapRadiusReadout.textContent = "Ocean Surge";
            } else if (isFlood) {
                const radius = Number(simulationConfig.hazardRadius) || 4.2;
                mapRadiusReadout.textContent = `${radius.toFixed(1)} km Inundation`;
            } else {
                const radius = Number(simulationConfig.hazardRadius) || 4.2;
                mapRadiusReadout.textContent = `${radius.toFixed(1)} km`;
            }
        }
    }

    function setupCycloneSwirlMarker(lng, lat, categoryInfo = null) {
        if (!map) return;
        const cat = categoryInfo || getCycloneCategory(currentProperties.windSpeed, currentProperties.stormSurge);
        const catTag = cat.tag || "CAT 3 · EYE";

        if (cycloneSwirlMarker) {
            cycloneSwirlMarker.setLngLat([lng, lat]);
            const tagEl = cycloneSwirlMarker.getElement().querySelector(".cyclone-tag");
            if (tagEl) {
                tagEl.innerHTML = `<span>🌀</span> <span>${catTag}</span>`;
            }
            return;
        }

        const el = document.createElement("div");
        el.className = "cyclone-swirl-container";
        el.id = "cycloneSwirlMarker";
        el.title = `Active Cyclone Vortex — ${catTag}`;
        el.innerHTML = `
            <div class="cyclone-tag"><span>🌀</span> <span>${catTag}</span></div>
            <svg class="cyclone-vortex-mesh" viewBox="0 0 100 100" width="76" height="76" aria-hidden="true">
                <!-- 6-blade cyclonic vortex silhouette matching meteorology standard icon -->
                <path class="cyclone-pinwheel-path" d="M 32.27 30.31 C 41.46 18.12 68.60 10.12 90.28 24.83 C 80.64 24.29 64.84 26.25 58.19 24.80 C 73.33 26.67 93.83 46.17 91.94 72.30 C 87.59 63.68 77.98 50.98 75.92 44.49 C 81.88 58.54 75.24 86.04 51.66 97.47 C 56.95 89.39 63.15 74.72 67.73 69.69 C 58.54 81.88 31.40 89.88 9.72 75.17 C 19.36 75.71 35.16 73.75 41.81 75.20 C 26.67 73.33 6.17 53.83 8.06 27.70 C 12.41 36.32 22.02 49.02 24.08 55.51 C 18.12 41.46 24.76 13.96 48.34 2.53 C 43.05 10.61 36.85 25.28 32.27 30.31 Z M 50 36.5 A 13.5 13.5 0 1 0 50 63.5 A 13.5 13.5 0 1 0 50 36.5 Z" fill-rule="evenodd"/>
            </svg>
        `;

        cycloneSwirlMarker = new maplibregl.Marker({
            element: el,
            anchor: "center",
            offset: [0, 0]
        })
        .setLngLat([lng, lat])
        .addTo(map);
    }

    function removeCycloneSwirlMarker() {
        if (cycloneSwirlMarker) {
            cycloneSwirlMarker.remove();
            cycloneSwirlMarker = null;
        }
    }

    /* ------------------------------------------------------------
       INTERACTIVE ORIGIN POINTER (EPICENTER BEACON)
    ------------------------------------------------------------ */
    function setupOriginMarker() {
        if (originMarker) {
            originMarker.remove();
            originMarker = null;
        }

        const el = document.createElement("div");
        el.className = "marker-origin-container";
        el.id = "hazardOriginMarker";
        
        const isTsunami = (simulationConfig.disaster || "").toLowerCase() === "tsunami";
        const badgeLabel = isTsunami ? "TSUNAMI" : `${(simulationConfig.disaster || "HAZARD").toUpperCase()} ORIGIN`;

        el.innerHTML = `
            <div class="origin-radar-ping ping-1"></div>
            <div class="origin-radar-ping ping-2"></div>
            <div class="origin-radar-ping ping-3"></div>
            <div class="origin-pin-wrapper origin-drop-anim">
                <div class="origin-pin-badge">
                    <span class="badge-dot"></span>
                    <span class="badge-text">${badgeLabel}</span>
                </div>
                <div class="origin-pointer-body">
                    <svg class="origin-pointer-svg" viewBox="0 0 32 48" width="32" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                            <filter id="originGlow" x="-30%" y="-30%" width="160%" height="160%">
                                <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#ef4444" flood-opacity="0.8"/>
                            </filter>
                            <linearGradient id="pinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#ff4444"/>
                                <stop offset="100%" stop-color="#b91c1c"/>
                            </linearGradient>
                        </defs>
                        <!-- Ground shadow ellipse -->
                        <ellipse cx="16" cy="47" rx="6" ry="1.8" fill="rgba(0,0,0,0.5)"/>
                        <!-- Teardrop pointer body with needle tip terminating exactly at bottom (16, 48) -->
                        <path d="M16 48 C 16 48, 2 30, 2 16 C 2 8.268, 8.268 2, 16 2 C 23.732 2, 30 8.268, 30 16 C 30 30, 16 48, 16 48 Z" 
                              fill="url(#pinGrad)" stroke="#ffffff" stroke-width="2.2" filter="url(#originGlow)"/>
                        <!-- Central tactical reticle rings -->
                        <circle cx="16" cy="16" r="8" fill="#0d1117" stroke="#ffffff" stroke-width="1.4"/>
                        <circle cx="16" cy="16" r="5" fill="#facc15"/>
                        <circle cx="16" cy="16" r="2.2" fill="#ef4444"/>
                        <line x1="16" y1="4" x2="16" y2="7.5" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round"/>
                        <line x1="16" y1="24.5" x2="16" y2="28" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round"/>
                        <line x1="4" y1="16" x2="7.5" y2="16" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round"/>
                        <line x1="24.5" y1="16" x2="28" y2="16" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                </div>
                <div class="origin-target-crosshair"></div>
            </div>
        `;

        el.title = `Hazard Origin: ${currentOrigin.latitude.toFixed(4)}° N, ${currentOrigin.longitude.toFixed(4)}° E`;

        const popup = new maplibregl.Popup({
            offset: [0, -54],
            closeButton: false,
            className: "origin-map-popup"
        }).setHTML(`
            <div class="origin-popup-content">
                <div class="origin-popup-title">🎯 ${disasterLabel} EPICENTER</div>
                <div class="origin-popup-coords">${currentOrigin.latitude.toFixed(4)}° N, ${currentOrigin.longitude.toFixed(4)}° E</div>
                <div class="origin-popup-note">Point of Origin Active</div>
            </div>
        `);

        originMarker = new maplibregl.Marker({
            element: el,
            anchor: "bottom",
            offset: [0, 0]
        })
            .setLngLat([currentOrigin.longitude, currentOrigin.latitude])
            .setPopup(popup)
            .addTo(map);

        el.addEventListener("mouseenter", () => {
            if (originMarker && originMarker.getPopup() && !originMarker.getPopup().isOpen()) {
                originMarker.togglePopup();
            }
        });
        el.addEventListener("mouseleave", () => {
            if (originMarker && originMarker.getPopup() && originMarker.getPopup().isOpen()) {
                originMarker.togglePopup();
            }
        });
    }

    function triggerOriginDropAnimation() {
        const el = originMarker?.getElement();
        if (!el) return;
        const wrapper = el.querySelector(".origin-pin-wrapper");
        if (wrapper) {
            wrapper.classList.remove("origin-drop-anim");
            void wrapper.offsetWidth; // trigger reflow
            wrapper.classList.add("origin-drop-anim");
        }
    }

    function showOriginEstablishedToast(lat, lng) {
        let toast = document.getElementById("originEstablishedToast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "originEstablishedToast";
            toast.className = "origin-established-toast";
            mapContainer.appendChild(toast);
        }
        const disasterLabel = (simulationConfig.disaster || "HAZARD").toUpperCase();
        toast.innerHTML = `
            <div class="toast-inner">
                <span class="toast-icon">📍</span>
                <div>
                    <div class="toast-title">POINT OF ORIGIN ESTABLISHED</div>
                    <div class="toast-coords">${disasterLabel} EPICENTER: ${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E</div>
                </div>
            </div>
        `;
        toast.classList.add("show");
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.classList.remove("show");
        }, 3200);
    }

    function setupOriginClickInteraction() {
        btnSetOrigin?.addEventListener("click", () => {
            isSelectingOrigin = !isSelectingOrigin;
            btnSetOrigin.classList.toggle("active", isSelectingOrigin);
            mapContainer.classList.toggle("selecting-origin", isSelectingOrigin);
            if (btnSetOriginText) {
                btnSetOriginText.textContent = isSelectingOrigin ? "CLICK MAP TO PLACE ORIGIN" : "SET ORIGIN ON MAP";
            }
            if (originSelectionHint) {
                originSelectionHint.textContent = isSelectingOrigin ? "Crosshair active: Click target coordinate on map" : "Click 'SET ORIGIN' then click on the map";
            }
        });

        map.on("click", async (e) => {
            if (!isSelectingOrigin) return;

            const newLng = e.lngLat.lng;
            const newLat = e.lngLat.lat;

            currentOrigin = { latitude: newLat, longitude: newLng };
            updateOriginReadout(newLat, newLng);

            if (!originMarker) {
                setupOriginMarker();
            } else {
                originMarker.setLngLat([newLng, newLat]);
                const el = originMarker.getElement();
                if (el) {
                    el.title = `Hazard Origin: ${newLat.toFixed(4)}° N, ${newLng.toFixed(4)}° E`;
                }
                const popup = originMarker.getPopup();
                if (popup) {
                    popup.setHTML(`
                        <div class="origin-popup-content">
                            <div class="origin-popup-title">🎯 ${(simulationConfig.disaster || "HAZARD").toUpperCase()} EPICENTER</div>
                            <div class="origin-popup-coords">${newLat.toFixed(4)}° N, ${newLng.toFixed(4)}° E</div>
                            <div class="origin-popup-note">Point of Origin Established</div>
                        </div>
                    `);
                }
            }

            // Visual feedback: Drop animation + Toast banner
            triggerOriginDropAnimation();
            showOriginEstablishedToast(newLat, newLng);

            // Update hazard envelope preview around new origin if not running live stream
            if (!simulationId || isPaused) {
                updatePreviewHazardPolygon();
            }

            // Sync with backend scenario and simulation
            try {
                if (scenarioId) {
                    await api.updateScenarioOrigin(scenarioId, newLat, newLng);
                }
                if (simulationId) {
                    await api.updateOrigin(simulationId, newLat, newLng);
                    if (wsConnection) {
                        wsConnection.send("origin", { latitude: newLat, longitude: newLng });
                    }
                }
            } catch (err) {
                console.warn("[RESQ] Error updating origin on backend:", err);
            }

            // Deactivate selection mode
            isSelectingOrigin = false;
            btnSetOrigin.classList.remove("active");
            mapContainer.classList.remove("selecting-origin");
            if (btnSetOriginText) btnSetOriginText.textContent = "SET ORIGIN ON MAP";
            if (originSelectionHint) {
                originSelectionHint.innerHTML = `<span style="color: #10b981; font-weight: 600;">✓ Origin pointer established at ${newLat.toFixed(4)}° N, ${newLng.toFixed(4)}° E</span>`;
            }
        });
    }

    /* ------------------------------------------------------------
       FALLBACK RENDERER (IF WEBGL / MAPBOX FAILS)
    ------------------------------------------------------------ */
    function renderMapFallback(container, center) {
        if (!container) return;
        container.innerHTML = `
            <div style="width:100%; height:100%; display:grid; place-items:center; background:#0d1115; color:#f4f5f6; font-family:'DM Mono', monospace; font-size:12px; text-align:center; padding:20px;">
                <div>
                    <div style="font-size:24px; margin-bottom:8px;">🗺️</div>
                    <div style="letter-spacing:0.16em; font-weight:700;">TACTICAL GEO-GRID ACTIVE</div>
                    <div style="color:rgba(255,255,255,0.4); margin-top:4px;">${simulationConfig.city}, ${simulationConfig.country} · ${center[1].toFixed(4)}° N, ${center[0].toFixed(4)}° E</div>
                    <div style="margin-top:12px; font-size:10px; color:#10b981;">Mapbox 3D Vector View Initialized</div>
                </div>
            </div>
        `;
    }

    /* ============================================================
       6. DYNAMIC DISASTER PROPERTIES PANEL SLIDERS
    ============================================================ */

    function setupPropertiesPanel() {
        const disaster = simulationConfig.disaster.toLowerCase();
        const schema = rules.properties[disaster] || [];

        propsDisasterSubtitle.textContent = `${disaster.toUpperCase()} SIMULATION PARAMETERS · ADJUST LIVE DYNAMICS`;
        propertiesGrid.innerHTML = "";

        schema.forEach(prop => {
            const currentVal = currentProperties[prop.id] !== undefined
                ? currentProperties[prop.id]
                : prop.defaultValue;

            currentProperties[prop.id] = currentVal;

            const field = document.createElement("div");
            field.className = "property-field";
            field.innerHTML = `
                <div class="prop-field-header">
                    <span class="prop-field-label">${prop.name}</span>
                    <span class="prop-field-val" id="val_${prop.id}">${currentVal} ${prop.unit}</span>
                </div>
                <div class="prop-slider-wrapper">
                    <input type="range" 
                        class="prop-slider" 
                        id="slider_${prop.id}" 
                        min="${prop.min}" 
                        max="${prop.max}" 
                        step="${prop.step}" 
                        value="${currentVal}" 
                        title="${prop.description}">
                </div>
            `;

            const slider = field.querySelector(`#slider_${prop.id}`);
            const valDisplay = field.querySelector(`#val_${prop.id}`);

            slider.addEventListener("input", async (e) => {
                const val = parseFloat(e.target.value);
                valDisplay.textContent = `${val} ${prop.unit}`;
                currentProperties[prop.id] = val;

                // If disaster is cyclone, dynamically update category and swath telemetry readout
                if ((simulationConfig.disaster || "").toLowerCase() === "cyclone") {
                    const wind = Number(currentProperties.windSpeed) || 175;
                    const surge = Number(currentProperties.stormSurge) || 3.2;
                    const cat = getCycloneCategory(wind, surge);
                    if (cycloneSwirlMarker) {
                        const tagEl = cycloneSwirlMarker.getElement().querySelector(".cyclone-tag");
                        if (tagEl) tagEl.innerHTML = `<span>🌀</span> <span>${cat.tag} · EYE</span>`;
                    }
                    if (disaster === "cyclone" && mapRadiusReadout) {
                        const nw = Math.max(0, Math.min(1, (currentProperties.windSpeed - 70) / 210.0));
                        const ns = Math.max(0, Math.min(1, (currentProperties.stormSurge - 0.5) / 7.5));
                        const radius = 1.0 + nw * 2.0 + ns * 1.0;
                        mapRadiusReadout.textContent = `${radius.toFixed(1)} km Gale Swath`;
                    }
                }

                // If disaster is earthquake, dynamically update preview zones when depth/PGA change
                if ((simulationConfig.disaster || "").toLowerCase() === "earthquake") {
                    if (!simulationId || isPaused || !isSimulationStarted) {
                        updatePreviewHazardPolygon();
                    } else if (mapRadiusReadout) {
                        const depth = Number(currentProperties.depth) || 12.0;
                        const maxRadius = 3.5 + (35.0 / Math.max(5.0, depth));
                        mapRadiusReadout.textContent = `${maxRadius.toFixed(1)} km (4 Seismic Zones)`;
                    }
                }

                // Sync to backend simulation
                if (simulationId) {
                    try {
                        await api.updateProperties(simulationId, { [prop.id]: val });
                        if (wsConnection) {
                            wsConnection.send("properties", { value: { [prop.id]: val } });
                        }
                    } catch (err) {
                        console.warn("[RESQ] Error updating property:", err);
                    }
                }
            });

            propertiesGrid.appendChild(field);
        });
    }

    btnEscalate?.addEventListener("click", async () => {
        const disaster = simulationConfig.disaster.toLowerCase();
        const schema = rules.properties[disaster] || [];
        const updated = {};
        schema.forEach(p => {
            const current = currentProperties[p.id] || p.defaultValue;
            const next = Math.min(p.max, current + (p.max - p.min) * 0.15);
            updated[p.id] = parseFloat(next.toFixed(1));
            currentProperties[p.id] = updated[p.id];
        });
        updatePropertySliderInputs();
        if (simulationId) {
            await api.updateProperties(simulationId, updated);
        }
    });

    btnMitigate?.addEventListener("click", async () => {
        const disaster = simulationConfig.disaster.toLowerCase();
        const schema = rules.properties[disaster] || [];
        const updated = {};
        schema.forEach(p => {
            const current = currentProperties[p.id] || p.defaultValue;
            const next = Math.max(p.min, current - (p.max - p.min) * 0.15);
            updated[p.id] = parseFloat(next.toFixed(1));
            currentProperties[p.id] = updated[p.id];
        });
        updatePropertySliderInputs();
        if (simulationId) {
            await api.updateProperties(simulationId, updated);
        }
    });

    function updatePropertySliderInputs() {
        const disaster = simulationConfig.disaster.toLowerCase();
        const schema = rules.properties[disaster] || [];
        schema.forEach(p => {
            const val = currentProperties[p.id];
            const slider = document.getElementById(`slider_${p.id}`);
            const display = document.getElementById(`val_${p.id}`);
            if (slider && val !== undefined) slider.value = val;
            if (display && val !== undefined) display.textContent = `${val} ${p.unit}`;
        });

        if (disaster === "cyclone") {
            const wind = Number(currentProperties.windSpeed) || 175;
            const surge = Number(currentProperties.stormSurge) || 3.2;
            const cat = getCycloneCategory(wind, surge);
            if (cycloneSwirlMarker) {
                const tagEl = cycloneSwirlMarker.getElement().querySelector(".cyclone-tag");
                if (tagEl) tagEl.innerHTML = `<span>🌀</span> <span>${cat.tag}</span>`;
            }
            if (mapRadiusReadout) {
                const nw = Math.max(0, Math.min(1, (wind - 70) / 210.0));
                const ns = Math.max(0, Math.min(1, (surge - 0.5) / 7.5));
                const radius = 1.0 + nw * 2.0 + ns * 1.0;
                mapRadiusReadout.textContent = `${radius.toFixed(1)} km Gale Swath`;
            }
        }

        if (disaster === "earthquake") {
            if (!simulationId || isPaused || !isSimulationStarted) {
                updatePreviewHazardPolygon();
            }
        }
    }

    /* ============================================================
       7. REAL-TIME TELEMETRY SYNCHRONIZATION
    ============================================================ */

    function applySimulationState(state) {
        if (!state) return;

        // 1. Overview Counters (Animated Ticks)
        if (state.metrics) {
            animateValue(counterAffected, state.metrics.affectedPopulation);
            if (deltaAffected && state.metrics.affectedPopulation !== undefined) {
                const currentAff = state.metrics.affectedPopulation;
                if (previousAffectedPopulation !== null && previousAffectedPopulation > 0) {
                    const diff = currentAff - previousAffectedPopulation;
                    const delta = (diff / previousAffectedPopulation) * 100;
                    if (delta > 0.05) {
                        deltaAffected.textContent = `↑ ${delta.toFixed(1)}%`;
                        deltaAffected.className = "metric-delta delta-up";
                    } else if (delta < -0.05) {
                        deltaAffected.textContent = `↓ ${Math.abs(delta).toFixed(1)}%`;
                        deltaAffected.className = "metric-delta delta-down";
                    } else {
                        deltaAffected.textContent = `— 0.0%`;
                        deltaAffected.className = "metric-delta delta-neutral";
                    }
                } else if (currentAff > 0) {
                    deltaAffected.textContent = `↑ ACTIVE`;
                    deltaAffected.className = "metric-delta delta-up";
                } else {
                    deltaAffected.textContent = `— 0.0%`;
                    deltaAffected.className = "metric-delta delta-neutral";
                }
                previousAffectedPopulation = currentAff;
            }
            if (counterCasualties && state.metrics.casualties !== undefined) {
                maxCasualtiesSeen = Math.max(maxCasualtiesSeen, state.metrics.casualties);
                animateValue(counterCasualties, maxCasualtiesSeen);
            }
            animateValue(counterBlockedRoads, state.metrics.blockedRoads);
            animateValue(counterShelters, state.metrics.activeShelters);
            animateValue(counterOutages, state.metrics.powerOutages);

            if (counterHospAvail) animateValue(counterHospAvail, state.metrics.availableHospitals);
            if (counterHospFull) animateValue(counterHospFull, state.metrics.fullHospitals);
            if (hospCapacityFill) {
                const pct = state.metrics.hospitalCapacityPct !== undefined
                    ? state.metrics.hospitalCapacityPct
                    : Math.round((state.metrics.fullHospitals / Math.max(1, state.metrics.totalHospitals || 1)) * 100);
                hospCapacityFill.style.width = `${Math.min(100, Math.max(2, pct))}%`;
            }
        }

        // 2. Severity Tag & Meter
        if (state.severity !== undefined) {
            const sevStr = `SEV ${state.severity.toFixed(1)}`;
            if (scenarioSeverityTag) scenarioSeverityTag.textContent = sevStr;
            if (sevValueBadge) sevValueBadge.textContent = `${state.severity.toFixed(1)} / 5.0`;
        }

        // 3. AI Situational Briefing
        if (state.aiResponse) {
            if (aiSummaryText && state.aiResponse.summary) {
                aiSummaryText.textContent = state.aiResponse.summary;
            }
            if (aiGuidanceText && state.aiResponse.guidance) {
                aiGuidanceText.textContent = state.aiResponse.guidance;
            }
            if (aiTimestamp && state.aiResponse.timestamp) {
                aiTimestamp.textContent = state.aiResponse.timestamp;
            }
        }

        // 4. Map Telemetry Radius
        if (mapRadiusReadout) {
            if ((simulationConfig.disaster || "").toLowerCase() === "tsunami") {
                mapRadiusReadout.textContent = "Ocean Surge";
            } else if ((simulationConfig.disaster || "").toLowerCase() === "cyclone") {
                mapRadiusReadout.textContent = state.hazardRadiusKm ? `${state.hazardRadiusKm.toFixed(1)} km Swath` : "C-Track Swath";
            } else if ((simulationConfig.disaster || "").toLowerCase() === "earthquake") {
                mapRadiusReadout.textContent = state.hazardRadiusKm ? `${state.hazardRadiusKm.toFixed(1)} km (4 Zones)` : "4 Seismic Zones";
            } else if ((simulationConfig.disaster || "").toLowerCase() === "flood") {
                mapRadiusReadout.textContent = state.hazardRadiusKm ? `${state.hazardRadiusKm.toFixed(1)} km Inundation` : "Inundation Zone";
            } else if (state.hazardRadiusKm) {
                mapRadiusReadout.textContent = `${state.hazardRadiusKm.toFixed(1)} km`;
            }
        }

        // Track simulation active state
        const elapsedSec = (state.elapsedSeconds !== undefined) ? state.elapsedSeconds : ((state.simulationTime !== undefined) ? state.simulationTime : 0);
        if (state.status === "RUNNING" || elapsedSec > 0) {
            isSimulationStarted = true;
        }

        // Cache latest authoritative simulation state for style loads and theme switches
        latestSimulationState = state;

        // 5. Update Mapbox Dynamic Layers
        updateMapboxLayers(state);

        // 6. Update Engine Adapter
        if (engine) engine.updateFromBackend(state);
    }

    function updateMapboxLayers(state) {
        if (!map) return;

        const light = isLightMode();
        const elapsedSec = (state.elapsedSeconds !== undefined) ? state.elapsedSeconds : ((state.simulationTime !== undefined) ? state.simulationTime : 0);
        // Active simulation check: evacuation routes, blocked roads, and cyclone swirl/swath ONLY appear after the sim starts!
        const isSimActive = isSimulationStarted || (state && state.status === "RUNNING") || (elapsedSec > 0);
        const isCyclone = (simulationConfig.disaster || "").toLowerCase() === "cyclone";
        const isEarthquake = (simulationConfig.disaster || "").toLowerCase() === "earthquake";
        const isFlood = (simulationConfig.disaster || "").toLowerCase() === "flood";

        // Cyclone Swirl & Eye Marker: ONLY exists if simulation is active AND elapsedSec > 0
        if (isCyclone) {
            if (isSimActive && state.cycloneEye && Array.isArray(state.cycloneEye) && state.cycloneEye.length === 2 && elapsedSec > 0) {
                setupCycloneSwirlMarker(state.cycloneEye[0], state.cycloneEye[1], state.cycloneCategory);
            } else {
                removeCycloneSwirlMarker();
            }
        } else {
            removeCycloneSwirlMarker();
        }

        // A. Hazard Polygon Envelope: Concentric circles for Earthquake, swept swath for Cyclone, or standard polygon
        if (map.getSource("hazard-source")) {
            if (isCyclone && (!isSimActive || elapsedSec === 0)) {
                map.getSource("hazard-source").setData({
                    type: "FeatureCollection",
                    features: []
                });
            } else if (isEarthquake) {
                let eqFeatures = [];
                if (Array.isArray(state.earthquakeZones) && state.earthquakeZones.length > 0) {
                    eqFeatures = state.earthquakeZones.map(z => ({
                        type: "Feature",
                        properties: {
                            name: z.name,
                            severity: z.severity,
                            fillColor: z.fillColor,
                            strokeColor: z.strokeColor,
                            fillOpacity: z.fillOpacity,
                            lineWidth: z.lineWidth
                        },
                        geometry: {
                            type: "Polygon",
                            coordinates: [z.coordinates]
                        }
                    }));
                } else if (state.earthquakeZones && Array.isArray(state.earthquakeZones.features)) {
                    eqFeatures = state.earthquakeZones.features;
                } else {
                    const r = Number(state.hazardRadiusKm) || 4.2;
                    const cLng = (state.origin && state.origin.longitude) || currentOrigin.longitude;
                    const cLat = (state.origin && state.origin.latitude) || currentOrigin.latitude;
                    eqFeatures = createEarthquakeConcentricFeatures(cLng, cLat, r);
                }
                map.getSource("hazard-source").setData({
                    type: "FeatureCollection",
                    features: eqFeatures
                });
            } else if (state.hazardPolygon && Array.isArray(state.hazardPolygon) && state.hazardPolygon.length > 0) {
                map.getSource("hazard-source").setData({
                    type: "FeatureCollection",
                    features: [{
                        type: "Feature",
                        properties: { 
                            name: isCyclone ? "Active Cyclone Swept Swath" : isFlood ? "Active Flood Water Inundation" : "Active Impact Hazard Zone",
                            fillColor: isFlood ? (light ? "#0284c7" : "#0284c7") : undefined,
                            strokeColor: isFlood ? (light ? "#0369a1" : "#38bdf8") : undefined,
                            fillOpacity: isFlood ? (light ? 0.40 : 0.32) : undefined,
                            lineWidth: isFlood ? (light ? 3.2 : 2.6) : undefined
                        },
                        geometry: {
                            type: "Polygon",
                            coordinates: [state.hazardPolygon]
                        }
                    }]
                });
            } else {
                map.getSource("hazard-source").setData({
                    type: "FeatureCollection",
                    features: []
                });
            }
        }

        // B. Blocked Roads (Red line layer) - Only visible when simulation is active
        if (map.getSource("blocked-roads-source")) {
            const blockedFeatures = (isSimActive && state.roads) ? state.roads
                .filter(r => r.blocked)
                .map(r => ({
                    type: "Feature",
                    properties: { name: r.name, blocked: true, damageState: r.damageState },
                    geometry: {
                        type: "LineString",
                        coordinates: r.coordinates
                    }
                })) : [];

            map.getSource("blocked-roads-source").setData({
                type: "FeatureCollection",
                features: blockedFeatures
            });
        }

        // C. Evacuation Corridors (Electric Blue line layer) - Only visible when simulation is active
        if (map.getSource("evac-routes-source")) {
            const evacFeatures = (isSimActive && state.evacuationRoutes) ? state.evacuationRoutes.map(r => ({
                type: "Feature",
                properties: {
                    name: r.name,
                    fromZone: r.fromZone || "",
                    toShelter: r.toShelter || "",
                    distanceKm: r.distanceKm || "",
                    status: "clear"
                },
                geometry: {
                    type: "LineString",
                    coordinates: r.coordinates
                }
            })) : [];

            map.getSource("evac-routes-source").setData({
                type: "FeatureCollection",
                features: evacFeatures
            });
        }

        // D. Update POI Marker Classes (Hospital full / available)
        // Uses classList to preserve MapLibre's internal marker anchoring classes
        if (state.hospitals) {
            state.hospitals.forEach(h => {
                const markerObj = poiMarkers.find(m => {
                    const el = m.getElement();
                    return el && el.dataset.poiId === h.id;
                });
                if (markerObj) {
                    const el = markerObj.getElement();
                    const span = el.querySelector("span");
                    if (h.operationalStatus === "FULL" || h.operationalStatus === "COMPROMISED") {
                        el.classList.remove("marker-hospital-avail");
                        el.classList.add("marker-hospital-full");
                        if (span) span.textContent = "✖";
                    } else {
                        el.classList.remove("marker-hospital-full");
                        el.classList.add("marker-hospital-avail");
                        if (span) span.textContent = "✚";
                    }
                }
            });
        }
    }

    function animateValue(elem, target) {
        if (!elem || target === undefined) return;
        const current = parseInt(elem.textContent.replace(/,/g, ""), 10) || 0;
        if (current === target) return;

        const diff = target - current;
        const step = Math.sign(diff) * Math.max(1, Math.round(Math.abs(diff) / 6));
        const next = current + step;

        elem.textContent = next.toLocaleString();
        if (next !== target) {
            requestAnimationFrame(() => animateValue(elem, target));
        }
    }

    /* ============================================================
       8. SIMULATION CONTROLS (START, PLAY/PAUSE, SPEED, RESET)
    ============================================================ */

    btnStartSim?.addEventListener("click", async () => {
        if (!simulationId) {
            btnStartSim.innerHTML = `<span class="btn-icon">⏳</span><span class="btn-text">CONNECTING...</span>`;
            await initializeBackendSimulation();
            if (!simulationId) {
                console.error("[RESQ] Backend simulation could not be initialized.");
                btnStartSim.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START SIMULATION</span>`;
                alert("Connecting to backend simulation engine. If Render was asleep, it may take ~30s to wake up. Please click again.");
                return;
            }
        }
        try {
            isSimulationStarted = true;
            await api.startSimulation(simulationId);
            if (wsConnection) wsConnection.send("start");
            isPaused = false;
            if (playPauseIcon) playPauseIcon.textContent = "⏸";
            if (playPauseText) playPauseText.textContent = "PAUSE";
            btnStartSim.style.opacity = "0.7";
            btnStartSim.innerHTML = `<span class="btn-icon">⚡</span><span class="btn-text">RUNNING</span>`;
        } catch (err) {
            isSimulationStarted = false;
            console.error("[RESQ] Failed to start simulation:", err);
            btnStartSim.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START SIMULATION</span>`;
        }
    });

    btnPlayPause?.addEventListener("click", async () => {
        if (!simulationId) return;
        try {
            if (!isPaused) {
                await api.pauseSimulation(simulationId);
                if (wsConnection) wsConnection.send("pause");
                isPaused = true;
                if (playPauseIcon) playPauseIcon.textContent = "▶";
                if (playPauseText) playPauseText.textContent = "RESUME";
            } else {
                await api.resumeSimulation(simulationId);
                if (wsConnection) wsConnection.send("resume");
                isPaused = false;
                if (playPauseIcon) playPauseIcon.textContent = "⏸";
                if (playPauseText) playPauseText.textContent = "PAUSE";
            }
        } catch (err) {
            console.error("[RESQ] Error toggling pause:", err);
        }
    });

    speedButtons.forEach(btn => {
        btn.addEventListener("click", async () => {
            speedButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            const speed = parseInt(btn.dataset.speed, 10) || 1;
            currentSpeed = speed;
            if (simulationId) {
                try {
                    await api.changeSpeed(simulationId, speed);
                    if (wsConnection) wsConnection.send("speed", { value: speed });
                } catch (err) {
                    console.error("[RESQ] Error changing speed:", err);
                }
            }
        });
    });

    btnReset?.addEventListener("click", async () => {
        if (!simulationId) return;
        try {
            isSimulationStarted = false;
            removeCycloneSwirlMarker();
            if (map && map.getSource("hazard-source")) {
                map.getSource("hazard-source").setData({ type: "FeatureCollection", features: [] });
            }
            const resetState = await api.resetSimulation(simulationId);
            if (wsConnection) wsConnection.send("reset");
            isPaused = true;
            if (playPauseIcon) playPauseIcon.textContent = "▶";
            if (playPauseText) playPauseText.textContent = "RESUME";
            if (btnStartSim) {
                btnStartSim.style.opacity = "1";
                btnStartSim.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START SIMULATION</span>`;
            }
            previousAffectedPopulation = null;
            maxCasualtiesSeen = 0;
            if (deltaAffected) {
                deltaAffected.textContent = "— 0.0%";
                deltaAffected.className = "metric-delta delta-neutral";
            }
            applySimulationState(resetState);
            updatePropertySliderInputs();
        } catch (err) {
            console.error("[RESQ] Error resetting simulation:", err);
        }
    });

    /* ============================================================
       9. MAP LAYER HUD TOGGLES
    ============================================================ */

    mapHudLayers?.addEventListener("click", (e) => {
        const btn = e.target.closest(".layer-pill");
        if (!btn || !map) return;

        const layerKey = btn.dataset.layer;
        const isActive = btn.classList.toggle("active");
        layerVisibility[layerKey] = isActive;

        if (layerKey === "roads") {
            if (map.getLayer("blocked-roads-casing")) map.setLayoutProperty("blocked-roads-casing", "visibility", isActive ? "visible" : "none");
            if (map.getLayer("blocked-roads-line")) map.setLayoutProperty("blocked-roads-line", "visibility", isActive ? "visible" : "none");
        } else if (layerKey === "evac") {
            if (map.getLayer("evac-routes-glow")) map.setLayoutProperty("evac-routes-glow", "visibility", isActive ? "visible" : "none");
            if (map.getLayer("evac-routes-casing")) map.setLayoutProperty("evac-routes-casing", "visibility", isActive ? "visible" : "none");
            if (map.getLayer("evac-routes-line")) map.setLayoutProperty("evac-routes-line", "visibility", isActive ? "visible" : "none");
        } else if (layerKey === "hazard") {
            if (map.getLayer("hazard-fill")) map.setLayoutProperty("hazard-fill", "visibility", isActive ? "visible" : "none");
            if (map.getLayer("hazard-line")) map.setLayoutProperty("hazard-line", "visibility", isActive ? "visible" : "none");
        } else if (layerKey === "origin") {
            const el = originMarker?.getElement();
            if (el) el.style.display = isActive ? "flex" : "none";
        } else if (layerKey === "hospitals" || layerKey === "shelters" || layerKey === "outages") {
            poiMarkers.forEach(m => {
                const el = m.getElement();
                if (el && el.dataset.poiType === (layerKey === "hospitals" ? "hospital" : layerKey === "shelters" ? "shelter" : "outage")) {
                    el.style.display = isActive ? "grid" : "none";
                }
            });
        }
    });

    /* ============================================================
       10. DESKTOP DRAGGABLE PANEL SPLITTERS (RESIZERS)
    ============================================================ */

    let isDraggingV1 = false;
    let isDraggingV2 = false;
    let isDraggingH = false;

    resizerV1?.addEventListener("mousedown", () => {
        isDraggingV1 = true;
        resizerV1.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });

    resizerV2?.addEventListener("mousedown", () => {
        isDraggingV2 = true;
        resizerV2.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });

    resizerH?.addEventListener("mousedown", () => {
        isDraggingH = true;
        resizerH.classList.add("dragging");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
        if (isDraggingV1) {
            const containerRect = workspaceTop.getBoundingClientRect();
            const offset = e.clientX - containerRect.left;
            const pct = (offset / containerRect.width) * 100;
            const clampedPct = Math.max(30, Math.min(65, pct));
            mapPanel.style.flex = `0 0 ${clampedPct}%`;
            if (map) map.resize();
        } else if (isDraggingV2) {
            const containerRect = workspaceTop.getBoundingClientRect();
            const offset = containerRect.right - e.clientX;
            const pct = (offset / containerRect.width) * 100;
            const clampedPct = Math.max(15, Math.min(45, pct));
            if (aiPanel) aiPanel.style.flex = `0 0 ${clampedPct}%`;
            if (map) map.resize();
        } else if (isDraggingH) {
            const totalHeight = window.innerHeight - 54;
            const propsHeight = totalHeight - e.clientY;
            const clampedHeight = Math.max(120, Math.min(340, propsHeight));
            propertiesPanel.style.height = `${clampedHeight}px`;
            if (map) map.resize();
        }
    });

    document.addEventListener("mouseup", () => {
        if (isDraggingV1) {
            isDraggingV1 = false;
            resizerV1?.classList.remove("dragging");
        }
        if (isDraggingV2) {
            isDraggingV2 = false;
            resizerV2?.classList.remove("dragging");
        }
        if (isDraggingH) {
            isDraggingH = false;
            resizerH?.classList.remove("dragging");
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (map) map.resize();
    });

    /* ============================================================
       11. MOBILE TAB SWITCHER (< 900px)
    ============================================================ */

    tabMapBtn?.addEventListener("click", () => {
        tabMapBtn.classList.add("active");
        tabPropsBtn.classList.remove("active");
        document.body.classList.remove("mobile-tab-props");
        if (map) setTimeout(() => map.resize(), 100);
    });

    tabPropsBtn?.addEventListener("click", () => {
        tabPropsBtn.classList.add("active");
        tabMapBtn.classList.remove("active");
        document.body.classList.add("mobile-tab-props");
    });

    /* ============================================================
       12. BACKEND INITIALIZATION ORCHESTRATION
    ============================================================ */

    async function initializeBackendSimulation() {
        try {
            // 1. Create or verify Scenario on backend
            if (!scenarioId) {
                const sc = await api.createScenario({
                    city: simulationConfig.city,
                    disaster: simulationConfig.disaster,
                    origin: {
                        latitude: currentOrigin.latitude,
                        longitude: currentOrigin.longitude
                    },
                    properties: currentProperties,
                    seed: 42
                });
                scenarioId = sc.id;
                currentProperties = sc.properties;
            }

            // 2. Instantiate Simulation on backend
            const sim = await api.createSimulation(scenarioId);
            simulationId = sim.simulationId;

            // Update localStorage
            simulationConfig.scenarioId = scenarioId;
            simulationConfig.simulationId = simulationId;
            localStorage.setItem("resqSimulation", JSON.stringify(simulationConfig));

            // 3. Connect real-time WebSocket
            wsConnection = api.connectSimulationWebSocket(simulationId, {
                onOpen: () => console.log("[RESQ] WebSocket live telemetry synchronized."),
                onMessage: (data) => {
                    if (data.event === "simulation.tick" || data.event === "simulation.init" || data.event === "simulation.reset") {
                        applySimulationState(data.state || data);
                    }
                },
                onError: (err) => console.warn("[RESQ] WebSocket streaming note:", err)
            });

            // Initial telemetry render
            applySimulationState(sim);

        } catch (err) {
            console.error("[RESQ] Failed to connect to backend simulation:", err);
        }
    }

    /* ============================================================
       13. STARTUP SEQUENCE
    ============================================================ */

    setupPropertiesPanel();
    initMap();
    initializeBackendSimulation();

})();
