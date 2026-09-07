/* ============================================================
   RESQ — SIMULATION ENGINE CLIENT ADAPTER
   Thin frontend state cache and adapter.
   All authoritative state, hazard progression, cascading failures,
   routing, and telemetry calculations are executed on the backend.
============================================================ */

class SimulationEngine {
    constructor(simulationConfig) {
        this.config = simulationConfig;
        this.api = window.RESQ_API;
        this.subscribers = new Set();
        this.state = this.initInitialState();
    }

    initInitialState() {
        const disaster = (this.config.disaster || "flood").toLowerCase();
        const cityPop = this.config.population || 4500000;

        return {
            city: this.config.city || "Chennai",
            country: this.config.country || "India",
            countryCode: this.config.countryCode || "IN",
            latitude: Number(this.config.latitude) || 13.0827,
            longitude: Number(this.config.longitude) || 80.2707,
            population: cityPop,
            disaster: disaster,
            severity: 2.8,
            elapsedTime: 0,
            speed: 1,
            isPaused: false,
            properties: {},
            metrics: {
                affectedPeople: 0,
                casualties: 0,
                hospitalsAvailable: 0,
                hospitalsFull: 0,
                hospitalsTotal: 0,
                blockedRoads: 0,
                activeShelters: 0,
                sheltersTotal: 0,
                powerOutages: 0,
            },
            aiResponse: {
                summary: "Awaiting backend telemetry synchronization...",
                guidance: "Establishing secure link with municipal crisis server...",
            },
        };
    }

    updateFromBackend(serverState) {
        if (!serverState) return;

        this.state.elapsedTime = serverState.elapsedSeconds || 0;
        this.state.severity = serverState.severity || 2.8;
        this.state.speed = serverState.speed || 1;
        this.state.isPaused = serverState.status === "PAUSED";
        this.state.properties = serverState.properties || {};

        if (serverState.metrics) {
            this.state.metrics.affectedPeople = serverState.metrics.affectedPopulation || 0;
            this.state.metrics.casualties = serverState.metrics.casualties || 0;
            this.state.metrics.hospitalsAvailable = serverState.metrics.availableHospitals || 0;
            this.state.metrics.hospitalsFull = serverState.metrics.fullHospitals || 0;
            this.state.metrics.hospitalsTotal = serverState.metrics.totalHospitals || 0;
            this.state.metrics.blockedRoads = serverState.metrics.blockedRoads || 0;
            this.state.metrics.activeShelters = serverState.metrics.activeShelters || 0;
            this.state.metrics.sheltersTotal = serverState.metrics.totalShelters || 0;
            this.state.metrics.powerOutages = serverState.metrics.powerOutages || 0;
        }

        if (serverState.aiResponse) {
            this.state.aiResponse = serverState.aiResponse;
        }

        this.notify();
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        fn(this.state);
        return () => this.subscribers.delete(fn);
    }

    notify() {
        this.subscribers.forEach(fn => {
            try {
                fn(this.state);
            } catch (err) {
                console.error("Simulation listener error:", err);
            }
        });
    }
}

if (typeof window !== "undefined") {
    window.SimulationEngine = SimulationEngine;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = SimulationEngine;
}
