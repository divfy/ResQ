# RESQ — Operational Memory & Session Log

> **MANDATORY PROTOCOL:** This file must be read FIRST before starting any task in any session. Update this file immediately after completing tasks or making design/architectural decisions.

---

## 1. Project Status & Resume Point

- **Current Status**: **Phase 3 (Full Backend & Frontend Integration) COMPLETED**
- **Current Phase**: Phase 3 — Authoritative Backend, Mapbox GL JS 3D, OSM Ingestion & Cascading Simulation
- **Active Task**: All backend modules, disaster physics models, NetworkX road network graph, cascading failure engine, WebSockets, Mapbox GL JS 3D visualization, interactive origin selection, and automated tests implemented and verified (14/14 tests passing).
- **Next Task**: User acceptance testing, live deployment, or extending additional city OSM datasets.

---

## 2. Completed Work Log

| Component / Milestone | Status | Description |
|---|---|---|
| **Phase 1: Landing Page** | ✅ COMPLETED | Autocomplete search, canvas disaster animations, dark/light theme, coordinates display, simulation parameter configuration. |
| **Command Dashboard UI** | ✅ COMPLETED | Zero-scroll 3-panel resizable desktop layout (Map left, Overview right, Disaster Properties bottom) with draggable splitters and responsive mobile tabs. |
| **FastAPI Backend Engine** | ✅ COMPLETED | Complete authoritative Python FastAPI backend (`backend/app/main.py`) with CORS, configuration endpoints, and robust error handling. |
| **Disaster Physics Models** | ✅ COMPLETED | `FloodDisaster`, `EarthquakeDisaster`, `CycloneDisaster`, and `TsunamiDisaster` with normalized 1.0-5.0 severity, time-growth curves, seismic/hydraulic attenuation, and coordinate-level damage states. |
| **OpenStreetMap Ingestion** | ✅ COMPLETED | Real cached OSM-derived infrastructure datasets for Delhi (`delhi_infrastructure.json`) and Chennai (`chennai_infrastructure.json`) covering roads, bridges, hospitals, shelters, power stations, and buildings. |
| **Cascading Failure Engine** | ✅ COMPLETED | Generic dependency propagation (`cascading/failure_engine.py`): Substation flooding/collapse -> power outages -> hospital backup power drain -> ICU/triage capacity reduction -> patient redirection; bridge collapses -> road closures. |
| **Road Network & Evacuation** | ✅ COMPLETED | `NetworkX` graph engine (`geospatial/routing.py` and `evacuation/engine.py`) with dynamic edge weights. Automatically detects blocked roads and recalculates safe evacuation corridors to operational shelters. |
| **Real-Time WebSocket Stream** | ✅ COMPLETED | `/ws/simulations/{id}` streaming incremental tick updates once per second and handling bidirectional action commands (`start`, `pause`, `resume`, `reset`, `speed`, `properties`, `origin`). |
| **3D Map Visualization** | ✅ COMPLETED | MapLibre GL JS integration with OpenFreeMap (100% free, keyless vector tiles) at 45° pitch with 3D buildings, solid red blocked roads (`#ef4444`), solid green evacuation routes (`#10b981`), yellow hazard zone (`rgba(245, 158, 11, 0.22)`), and POI markers (hospitals, shelters, outages) with telemetry popups. |
| **Interactive Origin Selection** | ✅ COMPLETED | "SET ORIGIN" control in Disaster Properties panel allows commanders to click anywhere on the map to set disaster epicenter/source, rendered with a high-visibility SVG pointer pin, base radar waves, impact drop animation, coordinates toast, and preview hazard polygon. |
| **Frontend API Client** | ✅ COMPLETED | Centralized `services/api.js` client managing scenario creation, simulation lifecycle, map data, property updates, and auto-reconnecting WebSockets. |
| **AI Decision Support** | ✅ COMPLETED | `ai/service.py` generating live situation summaries and evacuation directives from active telemetry, with Google Gemini API support and deterministic rule-based fallback. |
| **Automated Test Suite** | ✅ COMPLETED | 14 pytest unit and integration tests covering disaster physics, city compatibility, NetworkX dynamic routing, cascading dependencies, and REST API lifecycle with 100% pass rate. |
| **Documentation & Docker** | ✅ COMPLETED | `BACKEND.md`, `API.md`, `SETUP.md`, `Dockerfile`, `docker-compose.yml`, and `.env.example` created. |

---

## 3. Current File State

- `index.html`: Phase 1 Landing page with `services/api.js` integration.
- `style.css`: Landing page styles.
- `script.js`: Landing page logic with `validateDisasterCompatibility()` and scenario creation.
- `dashboard.html`: Command dashboard with Mapbox GL JS v3, START SIMULATION button, and Origin Selection bar.
- `dashboard.css`: Design tokens, glassmorphism, responsive splitters, and styles for Start Sim & Origin markers.
- `dashboard.js`: Dashboard orchestration, Mapbox 3D vector engine, interactive origin picking, and WebSocket sync.
- `simulation-engine.js`: Thin client adapter delegating authoritative simulation to backend.
- `services/api.js`: Centralized REST and WebSocket client service.
- `data/disaster-rules.js`: Static rules, compatibility matrices, and property schemas.
- `backend/app/main.py`: FastAPI application entry point.
- `backend/app/api/`: REST routes (`cities.py`, `scenarios.py`, `simulations.py`, `map.py`) and WebSocket (`websocket.py`).
- `backend/app/geospatial/`: OSM loader (`osm.py`), spatial math (`spatial.py`), and NetworkX routing (`routing.py`).
- `backend/app/disasters/`: `base.py`, `flood.py`, `earthquake.py`, `cyclone.py`, `tsunami.py`.
- `backend/app/cascading/`: `failure_engine.py` dependency propagation engine.
- `backend/app/evacuation/`: `engine.py` evacuation corridor solver.
- `backend/app/ai/`: `service.py` crisis synthesis engine.
- `backend/data/osm/`: Real OSM datasets for Delhi and Chennai.
- `backend/tests/`: Automated pytest test suite.
- `BACKEND.md`, `API.md`, `SETUP.md`: Comprehensive documentation.
- `Dockerfile`, `docker-compose.yml`: Local container infrastructure.
- `memory.md`: Active operational log.

---

## 4. Key Architectural Decisions

1. **Authoritative Backend**: Single source of truth. All hazard physics, cascading failure logic, NetworkX edge weights, and overview metrics compute on the backend and stream to the frontend via WebSockets.
2. **OpenFreeMap & MapLibre GL 3D**: Map engine operates at ~45° pitch with 3D buildings, dynamic red blocked lines, green evacuation corridors, yellow hazard zone polygons, and interactive POI markers using 100% keyless, free vector tiles from OpenFreeMap (`https://openfreemap.org/`).
3. **Interactive Origin Selection**: Commanders can click "SET ORIGIN" and drop a marker anywhere on the map to set the epicenter/source coordinates before or during the simulation.
4. **Resilient Data & AI**: Static OSM infrastructure cached locally in JSON/GeoJSON for offline reliability. Rule-based emergency sitrep generator ensures crisis briefings continue seamlessly if external AI APIs are unreachable.
