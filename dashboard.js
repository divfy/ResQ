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
    let currentOrigin = {
        latitude: Number(simulationConfig.latitude) || 13.0827,
        longitude: Number(simulationConfig.longitude) || 80.2707
    };
    let currentProperties = {};
    let isPaused = false;
    let currentSpeed = 1;
    let isSimulationStarted = false;

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
        const style = getTileStyle(isLightMode());
        map.setStyle(style);
        map.once("style.load", async () => {
            await loadStaticCityInfrastructure();
            setupDisasterLayers();
            setupOriginMarker();
            if (latestSimulationState) {
                updateMapboxLayers(latestSimulationState);
            }
        });
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
                        "line-color": isLightMode() ? "#94a3b8" : "#334155",
                        "line-width": 2.5,
                        "line-opacity": 0.6
                    }
                });
            }

            // 2. 3D Buildings from OSM disabled to remove greyish black boxes

            // 3. Spawn POI markers for Hospitals, Shelters, and Power Grid
            spawnInfrastructurePOIMarkers(cityData.pois.features);

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

        // 1. Hazard Polygon Overlay
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
                    "fill-color": light ? "#d97706" : "#f59e0b",
                    "fill-opacity": light ? 0.35 : 0.22
                }
            });

            map.addLayer({
                id: "hazard-line",
                source: "hazard-source",
                type: "line",
                paint: {
                    "line-color": light ? "#b45309" : "#f59e0b",
                    "line-width": light ? 3.0 : 2.0,
                    "line-dasharray": [3, 2]
                }
            });
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
        }

        // Reapply current active simulation data or initial preview
        if (latestSimulationState && isSimulationStarted) {
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
    }

    /* ------------------------------------------------------------
       HAZARD ENVELOPE PREVIEW GENERATOR
    ------------------------------------------------------------ */
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

    function updatePreviewHazardPolygon() {
        if (!map || !map.getSource("hazard-source")) return;
        const radius = Number(simulationConfig.hazardRadius) || 4.2;
        const polyCoords = createHazardCirclePolygon(currentOrigin.longitude, currentOrigin.latitude, radius);
        map.getSource("hazard-source").setData({
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                properties: { name: "Active Impact Hazard Zone" },
                geometry: {
                    type: "Polygon",
                    coordinates: [polyCoords]
                }
            }]
        });
        if (mapRadiusReadout) {
            mapRadiusReadout.textContent = `${radius.toFixed(1)} km`;
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
        
        const disasterLabel = (simulationConfig.disaster || "HAZARD").toUpperCase();

        el.innerHTML = `
            <div class="origin-radar-ping ping-1"></div>
            <div class="origin-radar-ping ping-2"></div>
            <div class="origin-radar-ping ping-3"></div>
            <div class="origin-pin-wrapper origin-drop-anim">
                <div class="origin-pin-badge">
                    <span class="badge-dot"></span>
                    <span class="badge-text">${disasterLabel} ORIGIN</span>
                </div>
                <div class="origin-pointer-body">
                    <svg class="origin-pointer-svg" viewBox="0 0 36 50" width="36" height="50" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                            <filter id="originGlow" x="-30%" y="-30%" width="160%" height="160%">
                                <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#ef4444" flood-opacity="0.9"/>
                            </filter>
                            <linearGradient id="pinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#ff4444"/>
                                <stop offset="100%" stop-color="#b91c1c"/>
                            </linearGradient>
                        </defs>
                        <!-- Ground shadow ellipse -->
                        <ellipse cx="18" cy="48" rx="7" ry="2.5" fill="rgba(0,0,0,0.55)"/>
                        <!-- Teardrop pointer body with sharp needle tip -->
                        <path d="M18 48 C 18 48, 3 31, 3 18 C 3 9.715, 9.715 3, 18 3 C 26.285 3, 33 9.715, 33 18 C 33 31, 18 48, 18 48 Z" 
                              fill="url(#pinGrad)" stroke="#ffffff" stroke-width="2.5" filter="url(#originGlow)"/>
                        <!-- Central tactical reticle rings -->
                        <circle cx="18" cy="18" r="9" fill="#0d1117" stroke="#ffffff" stroke-width="1.5"/>
                        <circle cx="18" cy="18" r="6" fill="#facc15"/>
                        <circle cx="18" cy="18" r="2.5" fill="#ef4444"/>
                        <line x1="18" y1="5" x2="18" y2="9" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
                        <line x1="18" y1="27" x2="18" y2="31" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
                        <line x1="5" y1="18" x2="9" y2="18" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
                        <line x1="27" y1="18" x2="31" y2="18" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
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
    }

    /* ============================================================
       7. REAL-TIME TELEMETRY SYNCHRONIZATION
    ============================================================ */

    function applySimulationState(state) {
        if (!state) return;

        // 1. Overview Counters (Animated Ticks)
        if (state.metrics) {
            animateValue(counterAffected, state.metrics.affectedPopulation);
            if (counterCasualties && state.metrics.casualties !== undefined) {
                animateValue(counterCasualties, state.metrics.casualties);
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
        if (mapRadiusReadout && state.hazardRadiusKm) {
            mapRadiusReadout.textContent = `${state.hazardRadiusKm.toFixed(1)} km`;
        }

        // Track simulation active state
        if (state.status === "RUNNING" || (state.elapsedSeconds && state.elapsedSeconds > 0)) {
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
        if (!map || !map.isStyleLoaded()) return;

        // A. Hazard Polygon Envelope
        if (state.hazardPolygon && map.getSource("hazard-source")) {
            map.getSource("hazard-source").setData({
                type: "FeatureCollection",
                features: [{
                    type: "Feature",
                    properties: { name: "Active Impact Hazard Zone" },
                    geometry: {
                        type: "Polygon",
                        coordinates: [state.hazardPolygon]
                    }
                }]
            });
        }

        // Active simulation check: evacuation routes and blocked roads should only appear after the sim starts!
        const isSimActive = isSimulationStarted || (state && state.status === "RUNNING") || (state && state.elapsedSeconds > 0);

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
                properties: { name: r.name, status: "clear" },
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
            const resetState = await api.resetSimulation(simulationId);
            if (wsConnection) wsConnection.send("reset");
            isPaused = true;
            if (playPauseIcon) playPauseIcon.textContent = "▶";
            if (playPauseText) playPauseText.textContent = "RESUME";
            if (btnStartSim) {
                btnStartSim.style.opacity = "1";
                btnStartSim.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START SIMULATION</span>`;
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
