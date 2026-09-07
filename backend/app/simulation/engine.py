"""Authoritative Simulation and Clock Engine for RESQ."""

import asyncio
import time
import uuid
from typing import Dict, Any, List, Optional, Set
from ..geospatial.osm import OSMLoader
from ..geospatial.routing import RoadNetwork
from ..geospatial.spatial import create_hazard_circle_polygon
from ..disasters import create_disaster_model
from ..cascading.failure_engine import CascadingFailureEngine
from ..evacuation.engine import EvacuationEngine
from ..ai.service import AIService
from ..core.logging import logger

class SimulationInstance:
    def __init__(
        self,
        simulation_id: str,
        scenario_id: str,
        city: str,
        disaster: str,
        origin_lat: float,
        origin_lng: float,
        properties: Dict[str, float] = None,
        seed: int = 42
    ):
        self.simulation_id = simulation_id
        self.scenario_id = scenario_id
        self.city = city
        self.disaster = disaster.lower()
        self.origin_lat = origin_lat
        self.origin_lng = origin_lng
        self.seed = seed
        self.properties = properties or {}
        
        # Load city OSM infrastructure
        self.infrastructure = OSMLoader.get_city_infrastructure(city)
        
        # Instantiate disaster hazard model
        self.hazard_model = create_disaster_model(self.disaster, self.properties)
        self.properties = self.hazard_model.properties
        
        # Build road network graph
        self.road_network = RoadNetwork(self.infrastructure.get("roads", []))
        
        # Engines
        self.cascade_engine = CascadingFailureEngine(self.infrastructure)
        self.evac_engine = EvacuationEngine(
            self.road_network,
            self.infrastructure.get("populationZones", []),
            self.infrastructure.get("shelters", [])
        )
        
        # Simulation Clock & State
        self.status = "INITIALIZED"  # INITIALIZED, RUNNING, PAUSED, STOPPED, COMPLETED
        self.elapsed_seconds = 0
        self.speed = 1
        self.task: Optional[asyncio.Task] = None
        self.subscribers: Set[Any] = set()
        
        # Current Snapshot State
        self.current_state: Dict[str, Any] = {}
        self._recalculate_full_state(initial=True)

    def _recalculate_full_state(self, initial: bool = False):
        """Execute full simulation step across all coupled engines."""
        severity = self.hazard_model.calculate_severity()
        hazard_radius_km = self.hazard_model.calculate_hazard_radius_km(self.elapsed_seconds)
        
        # 1. Cascading Failure Evaluation
        cascade_result = self.cascade_engine.evaluate_cascading_effects(
            self.elapsed_seconds,
            self.hazard_model,
            self.origin_lat,
            self.origin_lng
        )
        
        roads = cascade_result["roads"]
        hospitals = cascade_result["hospitals"]
        shelters = cascade_result["shelters"]
        power = cascade_result["power"]
        events = cascade_result["events"]
        
        # 2. Update Evacuation Routes based on blocked roads
        self.evac_engine.update_network_from_road_status(roads)
        evac_routes = self.evac_engine.compute_evacuation_routes(shelters)
        
        # 3. Aggregate Overview Metrics
        city_pop = self.infrastructure.get("population", 5000000)
        # Proportion of population inside hazard envelope
        hazard_ratio = min(0.35, (hazard_radius_km / 12.0) ** 1.5 * (severity / 3.0))
        affected_pop = max(1200, int(city_pop * hazard_ratio * (1.0 + self.elapsed_seconds / 300.0)))
        
        blocked_count = sum(1 for r in roads if r["blocked"])
        hosp_avail = sum(1 for h in hospitals if h["operationalStatus"] in ("OPERATIONAL", "STRESSED", "NEAR_CAPACITY") and h.get("availableBeds", 0) > 0)
        hosp_full = sum(1 for h in hospitals if h["operationalStatus"] in ("FULL", "COMPROMISED", "DAMAGED") or h.get("availableBeds", 0) == 0)
        shl_active = sum(1 for s in shelters if s["status"] == "OPERATIONAL")
        outages_count = sum(1 for p in power if p["status"] == "OFFLINE")

        total_beds = sum(int(h.get("beds", 0)) for h in hospitals)
        avail_beds = sum(int(h.get("availableBeds", 0)) for h in hospitals)
        used_beds = max(0, total_beds - avail_beds)
        hosp_capacity_pct = round((used_beds / max(1, total_beds)) * 100, 1) if total_beds > 0 else 0.0

        metrics = {
            "affectedPopulation": affected_pop,
            "availableHospitals": hosp_avail,
            "fullHospitals": hosp_full,
            "totalHospitals": len(hospitals),
            "blockedRoads": blocked_count,
            "activeShelters": shl_active,
            "totalShelters": len(shelters),
            "powerOutages": outages_count,
            "hospitalCapacityPct": hosp_capacity_pct,
            "totalBeds": total_beds,
            "availableBeds": avail_beds
        }
        
        # 4. Generate Hazard Polygon
        hazard_polygon = create_hazard_circle_polygon(
            self.origin_lng,
            self.origin_lat,
            hazard_radius_km
        )
        
        # 5. AI Synthesis
        ai_briefing = AIService._generate_rule_based_synthesis(
            self.city,
            self.disaster,
            severity,
            self.elapsed_seconds,
            metrics,
            hospitals,
            shelters,
            roads,
            power,
            events,
            self.properties
        )
        
        self.current_state = {
            "simulationId": self.simulation_id,
            "scenarioId": self.scenario_id,
            "city": self.city,
            "disaster": self.disaster,
            "status": self.status,
            "elapsedSeconds": self.elapsed_seconds,
            "speed": self.speed,
            "severity": severity,
            "hazardRadiusKm": hazard_radius_km,
            "origin": {
                "latitude": self.origin_lat,
                "longitude": self.origin_lng
            },
            "properties": self.properties,
            "metrics": metrics,
            "hospitals": hospitals,
            "shelters": shelters,
            "roads": roads,
            "power": power,
            "evacuationRoutes": evac_routes,
            "hazardPolygon": hazard_polygon,
            "events": events,
            "aiResponse": ai_briefing
        }

    async def _run_loop(self):
        """Tick-based async loop."""
        logger.info(f"Simulation loop started for {self.simulation_id}")
        try:
            while self.status == "RUNNING":
                await asyncio.sleep(1.0)
                if self.status != "RUNNING":
                    break
                
                # Advance simulated time
                delta_sim = 15 * self.speed
                self.elapsed_seconds += delta_sim
                
                # Recalculate
                self._recalculate_full_state()
                
                # Broadcast to WebSocket subscribers
                await self._broadcast_tick()
                
                # End condition if past recovery threshold
                if self.elapsed_seconds >= 1800:
                    self.status = "COMPLETED"
                    self.current_state["status"] = "COMPLETED"
                    await self._broadcast_tick()
                    break
        except asyncio.CancelledError:
            logger.info(f"Simulation loop cancelled for {self.simulation_id}")
        except Exception as e:
            logger.error(f"Error in simulation loop: {e}", exc_info=True)

    async def _broadcast_tick(self):
        payload = {
            "event": "simulation.tick",
            "simulationId": self.simulation_id,
            "simulationTime": self.elapsed_seconds,
            "status": self.status,
            "severity": self.current_state["severity"],
            "hazardRadiusKm": self.current_state["hazardRadiusKm"],
            "metrics": self.current_state["metrics"],
            "hazardPolygon": self.current_state["hazardPolygon"],
            "roads": [
                {"id": r["id"], "name": r["name"], "blocked": r["blocked"], "damageState": r["damageState"], "coordinates": r["coordinates"]}
                for r in self.current_state["roads"]
            ],
            "hospitals": self.current_state["hospitals"],
            "shelters": self.current_state["shelters"],
            "power": self.current_state["power"],
            "evacuationRoutes": self.current_state["evacuationRoutes"],
            "aiResponse": self.current_state["aiResponse"],
            "events": self.current_state["events"]
        }
        
        dead = []
        for ws in self.subscribers:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.subscribers.discard(ws)

    def start(self):
        if self.status != "RUNNING":
            self.status = "RUNNING"
            self.current_state["status"] = "RUNNING"
            if not self.task or self.task.done():
                self.task = asyncio.create_task(self._run_loop())

    def pause(self):
        if self.status == "RUNNING":
            self.status = "PAUSED"
            self.current_state["status"] = "PAUSED"

    def resume(self):
        if self.status == "PAUSED":
            self.start()

    def reset(self):
        self.pause()
        if self.task and not self.task.done():
            self.task.cancel()
        self.elapsed_seconds = 0
        self.status = "INITIALIZED"
        self._recalculate_full_state(initial=True)

    def stop(self):
        self.status = "STOPPED"
        self.current_state["status"] = "STOPPED"
        if self.task and not self.task.done():
            self.task.cancel()

    def set_speed(self, speed: int):
        self.speed = max(1, min(5, speed))
        self.current_state["speed"] = self.speed

    def update_properties(self, new_props: Dict[str, float]):
        self.properties.update(new_props)
        self.hazard_model = create_disaster_model(self.disaster, self.properties)
        self._recalculate_full_state()

    def set_origin(self, lat: float, lng: float):
        self.origin_lat = lat
        self.origin_lng = lng
        self._recalculate_full_state()


class SimulationManager:
    """Singleton simulation registry and factory."""
    _simulations: Dict[str, SimulationInstance] = {}
    _scenarios: Dict[str, Dict[str, Any]] = {}

    @classmethod
    def create_scenario(
        cls,
        city: str,
        disaster: str,
        origin_lat: Optional[float] = None,
        origin_lng: Optional[float] = None,
        properties: Optional[Dict[str, float]] = None,
        seed: int = 42
    ) -> Dict[str, Any]:
        infra = OSMLoader.get_city_infrastructure(city)
        supported = [d.lower() for d in infra.get("supportedDisasters", [])]
        if disaster.lower() not in supported:
            raise ValueError(f"{disaster.capitalize()} is not supported for {city}. Supported: {supported}")

        lat = origin_lat if origin_lat is not None else infra.get("latitude", 0.0)
        lng = origin_lng if origin_lng is not None else infra.get("longitude", 0.0)

        hazard = create_disaster_model(disaster, properties)
        
        scenario_id = str(uuid.uuid4())
        scenario = {
            "id": scenario_id,
            "city": infra["city"],
            "disaster": disaster.lower(),
            "origin": {"latitude": lat, "longitude": lng},
            "properties": hazard.properties,
            "severity": hazard.calculate_severity(),
            "seed": seed,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }
        cls._scenarios[scenario_id] = scenario
        return scenario

    @classmethod
    def get_scenario(cls, scenario_id: str) -> Optional[Dict[str, Any]]:
        return cls._scenarios.get(scenario_id)

    @classmethod
    def create_simulation(cls, scenario_id: str) -> SimulationInstance:
        scenario = cls._scenarios.get(scenario_id)
        if not scenario:
            raise ValueError(f"Scenario {scenario_id} not found.")

        sim_id = str(uuid.uuid4())
        sim = SimulationInstance(
            simulation_id=sim_id,
            scenario_id=scenario_id,
            city=scenario["city"],
            disaster=scenario["disaster"],
            origin_lat=scenario["origin"]["latitude"],
            origin_lng=scenario["origin"]["longitude"],
            properties=scenario["properties"],
            seed=scenario["seed"]
        )
        cls._simulations[sim_id] = sim
        return sim

    @classmethod
    def get_simulation(cls, simulation_id: str) -> Optional[SimulationInstance]:
        return cls._simulations.get(simulation_id)
