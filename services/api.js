/**
 * RESQ Centralized Frontend API and WebSocket Client Service
 */

function getResolvedApiUrl() {
    if (typeof window !== "undefined") {
        if (window.RESQ_API_URL) return window.RESQ_API_URL.replace(/\/+$/, "");
        const stored = localStorage.getItem("resq_api_url");
        if (stored) return stored.replace(/\/+$/, "");
        if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
            return "http://localhost:8000/api/v1";
        }
    }
    return "http://localhost:8000/api/v1";
}

function getResolvedWsUrl() {
    if (typeof window !== "undefined") {
        if (window.RESQ_WS_URL) return window.RESQ_WS_URL.replace(/\/+$/, "");
        const stored = localStorage.getItem("resq_ws_url");
        if (stored) return stored.replace(/\/+$/, "");
        const apiUrl = getResolvedApiUrl();
        if (apiUrl.startsWith("https://")) {
            return apiUrl.replace("https://", "wss://").replace(/\/api\/v1\/?$/, "");
        } else if (apiUrl.startsWith("http://")) {
            return apiUrl.replace("http://", "ws://").replace(/\/api\/v1\/?$/, "");
        }
    }
    return "ws://localhost:8000";
}

const RESQ_API = {
    get baseUrl() {
        return getResolvedApiUrl();
    },
    get wsBaseUrl() {
        return getResolvedWsUrl();
    },

    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            "Content-Type": "application/json",
            ...(options.headers || {})
        };

        try {
            const resp = await fetch(url, { ...options, headers });
            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                throw new Error(errData.detail?.message || errData.detail || `HTTP error ${resp.status}`);
            }
            return await resp.json();
        } catch (err) {
            console.warn(`[RESQ.API] Request failed on ${endpoint}:`, err.message);
            throw err;
        }
    },

    // Config & Metadata
    async getConfig() {
        return this.request("/config");
    },

    async getCities() {
        return this.request("/cities");
    },

    async getCity(cityId) {
        return this.request(`/cities/${cityId}`);
    },

    async getCityMapData(cityId) {
        return this.request(`/cities/${cityId}/map`);
    },

    // Scenarios
    async createScenario(scenarioData) {
        return this.request("/scenarios", {
            method: "POST",
            body: JSON.stringify(scenarioData)
        });
    },

    async getScenario(scenarioId) {
        return this.request(`/scenarios/${scenarioId}`);
    },

    async updateScenarioOrigin(scenarioId, latitude, longitude) {
        return this.request(`/scenarios/${scenarioId}/origin`, {
            method: "PATCH",
            body: JSON.stringify({ latitude, longitude })
        });
    },

    // Simulations Lifecycle
    async createSimulation(scenarioId) {
        return this.request("/simulations", {
            method: "POST",
            body: JSON.stringify({ scenarioId })
        });
    },

    async getSimulationState(simulationId) {
        return this.request(`/simulations/${simulationId}/state`);
    },

    async startSimulation(simulationId) {
        return this.request(`/simulations/${simulationId}/start`, { method: "POST" });
    },

    async pauseSimulation(simulationId) {
        return this.request(`/simulations/${simulationId}/pause`, { method: "POST" });
    },

    async resumeSimulation(simulationId) {
        return this.request(`/simulations/${simulationId}/resume`, { method: "POST" });
    },

    async resetSimulation(simulationId) {
        return this.request(`/simulations/${simulationId}/reset`, { method: "POST" });
    },

    async stopSimulation(simulationId) {
        return this.request(`/simulations/${simulationId}/stop`, { method: "POST" });
    },

    async changeSpeed(simulationId, speed) {
        return this.request(`/simulations/${simulationId}/speed`, {
            method: "PATCH",
            body: JSON.stringify({ speed })
        });
    },

    async updateProperties(simulationId, properties) {
        return this.request(`/simulations/${simulationId}/properties`, {
            method: "PATCH",
            body: JSON.stringify({ properties })
        });
    },

    async updateOrigin(simulationId, latitude, longitude) {
        return this.request(`/simulations/${simulationId}/origin`, {
            method: "PATCH",
            body: JSON.stringify({ latitude, longitude })
        });
    },

    // Dynamic GeoJSON Layers
    async getRoadsGeoJSON(simulationId) {
        return this.request(`/simulations/${simulationId}/roads`);
    },

    async getHazardsGeoJSON(simulationId) {
        return this.request(`/simulations/${simulationId}/hazards`);
    },

    async getEvacuationRoutesGeoJSON(simulationId) {
        return this.request(`/simulations/${simulationId}/evacuation-routes`);
    },

    // Real-Time WebSocket Connection
    connectSimulationWebSocket(simulationId, callbacks = {}) {
        const wsUrl = `${this.wsBaseUrl}/ws/simulations/${simulationId}`;
        console.log(`[RESQ.WS] Connecting to ${wsUrl}...`);

        let ws = null;
        let reconnectTimer = null;
        let isManuallyClosed = false;

        function connect() {
            try {
                ws = new WebSocket(wsUrl);

                ws.onopen = () => {
                    console.log(`[RESQ.WS] Connected successfully to simulation ${simulationId}`);
                    if (callbacks.onOpen) callbacks.onOpen();
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (callbacks.onMessage) callbacks.onMessage(data);
                    } catch (err) {
                        console.error("[RESQ.WS] Failed to parse message:", err);
                    }
                };

                ws.onerror = (err) => {
                    console.warn("[RESQ.WS] WebSocket error:", err);
                    if (callbacks.onError) callbacks.onError(err);
                };

                ws.onclose = (event) => {
                    console.log(`[RESQ.WS] Closed with code ${event.code}`);
                    if (callbacks.onClose) callbacks.onClose(event);

                    if (!isManuallyClosed) {
                        clearTimeout(reconnectTimer);
                        reconnectTimer = setTimeout(() => {
                            console.log("[RESQ.WS] Attempting auto-reconnect...");
                            connect();
                        }, 2000);
                    }
                };
            } catch (e) {
                console.error("[RESQ.WS] Setup exception:", e);
            }
        }

        connect();

        return {
            send(action, payload = {}) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action, ...payload }));
                }
            },
            close() {
                isManuallyClosed = true;
                clearTimeout(reconnectTimer);
                if (ws) ws.close();
            }
        };
    }
};

if (typeof window !== "undefined") {
    window.RESQ_API = RESQ_API;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RESQ_API;
}
