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
    const propertiesPanel = document.getElementById("propertiesPanel");
    const resizerV = document.getElementById("resizerV");
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
        const latDir = lat >= 0 ? "N" : "S";
        const lngDir = lng >= 0 ? "E" : "W";
        const readout = `${Math.abs(lat).toFixed(4)}° ${latDir} / ${Math.abs(lng).toFixed(4)}° ${lngDir}`;
        if (mapCoordsReadout) mapCoordsReadout.textContent = readout;
        if (originCoordsVal) originCoordsVal.textContent = readout;
    }

    /* ============================================================
       5. OPENFREEMAP & MAPLIBRE GL JS 3D (45° PITCH - ZERO API KEY)
    ============================================================ */

    let map = null;
    let poiMarkers = [];
    const layerVisibility = {
        roads: true,
        evac: true,
        hazard: true,
        hospitals: true,
        shelters: true,
        outages: true,
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
                setupDisasterLayers();
                setupOriginMarker();
                await loadStaticCityInfrastructure();
                setupOriginClickInteraction();
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
            setupDisasterLayers();
            setupOriginMarker();
            await loadStaticCityInfrastructure();
        });
    }

    /* ------------------------------------------------------------
       3D BUILDING LAYER EXTRUSIONS
    ------------------------------------------------------------ */
    function setup3DBuildingLayer(buildingsGeoJSON) {
        if (!map) return;

        if (buildingsGeoJSON && !map.getSource("3d-buildings-source")) {
            map.addSource("3d-buildings-source", {
                type: "geojson",
                data: buildingsGeoJSON
            });

            map.addLayer({
                id: "3d-buildings",
                source: "3d-buildings-source",
                type: "fill-extrusion",
                minzoom: 11,
                paint: {
                    "fill-extrusion-color": isLightMode() ? "#b8c2c8" : "#1e293b",
                    "fill-extrusion-height": ["get", "height"],
                    "fill-extrusion-base": ["get", "min_height"],
                    "fill-extrusion-opacity": 0.85
                }
            });
        }
    }

    /* ------------------------------------------------------------
       STATIC OSM CITY INFRASTRUCTURE
    ------------------------------------------------------------ */
    async function loadStaticCityInfrastructure() {
        if (!map) return;

        try {
            const cityData = await api.getCityMapData(simulationConfig.city);
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
                    paint: {
                        "line-color": isLightMode() ? "#94a3b8" : "#334155",
                        "line-width": 2,
                        "line-opacity": 0.5
                    }
                });
            }

            // 2. Setup 3D Buildings from OSM
            setup3DBuildingLayer(cityData.buildings);

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

            const marker = new maplibregl.Marker({ element: el })
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
                    "fill-color": "#f59e0b",
                    "fill-opacity": 0.22
                }
            });

            map.addLayer({
                id: "hazard-line",
                source: "hazard-source",
                type: "line",
                paint: {
                    "line-color": "#f59e0b",
                    "line-width": 2,
                    "line-dasharray": [3, 2]
                }
            });
        }

        // 2. Blocked Roads (Solid Red Line Layer)
        if (!map.getSource("blocked-roads-source")) {
            map.addSource("blocked-roads-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            map.addLayer({
                id: "blocked-roads-line",
                source: "blocked-roads-source",
                type: "line",
                paint: {
                    "line-color": "#ef4444",
                    "line-width": 4.5,
                    "line-opacity": 0.95
                }
            });
        }

        // 3. Evacuation Routes (Solid Green Line Layer)
        if (!map.getSource("evac-routes-source")) {
            map.addSource("evac-routes-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            map.addLayer({
                id: "evac-routes-line",
                source: "evac-routes-source",
                type: "line",
                paint: {
                    "line-color": "#10b981",
                    "line-width": 4.5,
                    "line-opacity": 0.95
                }
            });
        }
    }

    /* ------------------------------------------------------------
       INTERACTIVE ORIGIN SELECTION
    ------------------------------------------------------------ */
    function setupOriginMarker() {
        if (originMarker) originMarker.remove();

        const el = document.createElement("div");
        el.className = "marker-origin";
        el.innerHTML = "<span>🎯</span>";
        el.title = `Hazard Epicenter: ${currentOrigin.latitude.toFixed(4)}° N, ${currentOrigin.longitude.toFixed(4)}° E`;

        originMarker = new maplibregl.Marker({ element: el })
            .setLngLat([currentOrigin.longitude, currentOrigin.latitude])
            .addTo(map);
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

            if (originMarker) {
                originMarker.setLngLat([newLng, newLat]);
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
            if (originSelectionHint) originSelectionHint.textContent = "Origin updated! Ready to simulate.";
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
            animateValue(counterBlockedRoads, state.metrics.blockedRoads);
            animateValue(counterShelters, state.metrics.activeShelters);
            animateValue(counterOutages, state.metrics.powerOutages);

            if (counterHospAvail) counterHospAvail.textContent = state.metrics.availableHospitals;
            if (counterHospFull) counterHospFull.textContent = state.metrics.fullHospitals;
            if (hospCapacityFill) {
                const total = state.metrics.totalHospitals || 1;
                const pct = Math.round((state.metrics.fullHospitals / total) * 100);
                hospCapacityFill.style.width = `${pct}%`;
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

        // B. Blocked Roads (Red line layer)
        if (state.roads && map.getSource("blocked-roads-source")) {
            const blockedFeatures = state.roads
                .filter(r => r.blocked)
                .map(r => ({
                    type: "Feature",
                    properties: { name: r.name, blocked: true, damageState: r.damageState },
                    geometry: {
                        type: "LineString",
                        coordinates: r.coordinates
                    }
                }));

            map.getSource("blocked-roads-source").setData({
                type: "FeatureCollection",
                features: blockedFeatures
            });
        }

        // C. Evacuation Corridors (Green line layer)
        if (state.evacuationRoutes && map.getSource("evac-routes-source")) {
            const evacFeatures = state.evacuationRoutes.map(r => ({
                type: "Feature",
                properties: { name: r.name, status: "clear" },
                geometry: {
                    type: "LineString",
                    coordinates: r.coordinates
                }
            }));

            map.getSource("evac-routes-source").setData({
                type: "FeatureCollection",
                features: evacFeatures
            });
        }

        // D. Update POI Marker Classes (Hospital full / available)
        if (state.hospitals) {
            state.hospitals.forEach(h => {
                const markerObj = poiMarkers.find(m => {
                    const el = m.getElement();
                    return el && el.dataset.poiId === h.id;
                });
                if (markerObj) {
                    const el = markerObj.getElement();
                    if (h.operationalStatus === "FULL" || h.operationalStatus === "COMPROMISED") {
                        el.className = "map-marker marker-hospital-full";
                        el.innerHTML = "<span>✖</span>";
                    } else {
                        el.className = "map-marker marker-hospital-avail";
                        el.innerHTML = "<span>✚</span>";
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
            await api.startSimulation(simulationId);
            if (wsConnection) wsConnection.send("start");
            isPaused = false;
            if (playPauseIcon) playPauseIcon.textContent = "⏸";
            if (playPauseText) playPauseText.textContent = "PAUSE";
            btnStartSim.style.opacity = "0.7";
            btnStartSim.innerHTML = `<span class="btn-icon">⚡</span><span class="btn-text">RUNNING</span>`;
        } catch (err) {
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

        if (layerKey === "roads" && map.getLayer("blocked-roads-line")) {
            map.setLayoutProperty("blocked-roads-line", "visibility", isActive ? "visible" : "none");
        } else if (layerKey === "evac" && map.getLayer("evac-routes-line")) {
            map.setLayoutProperty("evac-routes-line", "visibility", isActive ? "visible" : "none");
        } else if (layerKey === "hazard") {
            if (map.getLayer("hazard-fill")) map.setLayoutProperty("hazard-fill", "visibility", isActive ? "visible" : "none");
            if (map.getLayer("hazard-line")) map.setLayoutProperty("hazard-line", "visibility", isActive ? "visible" : "none");
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

    let isDraggingV = false;
    resizerV?.addEventListener("mousedown", () => {
        isDraggingV = true;
        resizerV.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });

    let isDraggingH = false;
    resizerH?.addEventListener("mousedown", () => {
        isDraggingH = true;
        resizerH.classList.add("dragging");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
        if (isDraggingV) {
            const containerRect = workspaceTop.getBoundingClientRect();
            const offset = e.clientX - containerRect.left;
            const pct = (offset / containerRect.width) * 100;
            const clampedPct = Math.max(25, Math.min(75, pct));
            mapPanel.style.flex = `0 0 ${clampedPct}%`;
            overviewPanel.style.flex = `0 0 ${100 - clampedPct}%`;
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
        if (isDraggingV) {
            isDraggingV = false;
            resizerV.classList.remove("dragging");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            if (map) map.resize();
        }
        if (isDraggingH) {
            isDraggingH = false;
            resizerH.classList.remove("dragging");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            if (map) map.resize();
        }
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
