"""Cascading failure and infrastructure dependency engine.

The engine deliberately keeps the dependency chain deterministic:
hazard -> physical asset exposure -> asset state -> dependent network state.
It does not invent a route or silently restore a failed asset.
"""

from typing import Dict, List, Any
from ..core.logging import logger
from ..geospatial.spatial import haversine_distance_km


class CascadingFailureEngine:
    def __init__(self, infrastructure: Dict[str, Any]):
        self.infrastructure = infrastructure
        self.events: List[Dict[str, Any]] = []
        self._previous_states: Dict[str, str] = {}
        self._road_entry_time: Dict[str, float] = {}

    def _event_on_transition(self, key: str, new_state: str, event: Dict[str, Any]):
        old_state = self._previous_states.get(key)
        self._previous_states[key] = new_state
        if old_state is not None and old_state == new_state:
            return
        if old_state is not None and old_state != new_state:
            self.events.append(event)

    def evaluate_cascading_effects(self, elapsed_seconds, hazard_model, origin_lat, origin_lng):
        self.events = []
        power = self._evaluate_power_grid(hazard_model, origin_lat, origin_lng, elapsed_seconds)
        bridges = self._evaluate_bridges(hazard_model, origin_lat, origin_lng, elapsed_seconds)
        roads = self._evaluate_roads(hazard_model, origin_lat, origin_lng, elapsed_seconds, bridges)
        hospitals = self._evaluate_hospitals(hazard_model, origin_lat, origin_lng, elapsed_seconds, power)
        shelters = self._evaluate_shelters(hazard_model, origin_lat, origin_lng, elapsed_seconds, roads)
        return {"power": power, "bridges": bridges, "roads": roads, "hospitals": hospitals, "shelters": shelters, "events": self.events}

    def _evaluate_power_grid(self, hazard, origin_lat, origin_lng, elapsed):
        results = []
        for station in self.infrastructure.get("powerStations", []):
            impact = hazard.evaluate_point_impact(station["latitude"], station["longitude"], origin_lat, origin_lng, elapsed)
            status = "OPERATIONAL"
            if impact["in_hazard_zone"]:
                if hazard.name in ("flood", "tsunami", "cyclone") and station.get("floodProne", False):
                    status = "FLOODED_OUTAGE"
                elif hazard.name == "earthquake" and impact.get("local_pga", 0) > .25:
                    status = "SEISMIC_TRIP"
                elif hazard.name == "cyclone" and impact.get("wind_speed", 0) > 135:
                    status = "GRID_COLLAPSE"
            offline = status != "OPERATIONAL"
            key = f"power:{station['id']}"
            self._event_on_transition(key, "OFFLINE" if offline else "OPERATIONAL", {
                "type": "POWER_OUTAGE", "assetId": station["id"], "name": station["name"],
                "message": f"Power substation {station['name']} transitioned to {status}."
            }) if elapsed > 0 else self._previous_states.setdefault(key, "OFFLINE" if offline else "OPERATIONAL")
            results.append({
                "id": station["id"], "name": station["name"], "latitude": station["latitude"], "longitude": station["longitude"],
                "status": "OFFLINE" if offline else "OPERATIONAL", "failureMode": status,
                "supplies": station.get("supplies", []), "capacityMW": station.get("capacityMW", 100),
            })
        return results

    def _evaluate_bridges(self, hazard, origin_lat, origin_lng, elapsed):
        results = []
        for bridge in self.infrastructure.get("bridges", []):
            impact = hazard.evaluate_point_impact(bridge["latitude"], bridge["longitude"], origin_lat, origin_lng, elapsed)
            status = "OPEN"
            if impact["in_hazard_zone"]:
                if hazard.name == "earthquake" and impact.get("local_pga", 0) > .35:
                    status = "COLLAPSED"
                elif hazard.name in ("flood", "tsunami") and impact["intensity"] > .6:
                    status = "SUBMERGED_CLOSED"
                elif hazard.name == "cyclone" and impact["intensity"] > .8:
                    status = "STRUCTURAL_RISK"
            closed = status != "OPEN"
            key = f"bridge:{bridge['id']}"
            if elapsed > 0:
                self._event_on_transition(key, status, {
                    "type": "BRIDGE_DAMAGED", "bridgeId": bridge["id"], "name": bridge["name"], "status": status,
                    "message": f"Bridge {bridge['name']} transitioned to {status}."
                })
            else:
                self._previous_states.setdefault(key, status)
            results.append({"id": bridge["id"], "name": bridge["name"], "status": status, "is_closed": closed})
        return results

    @staticmethod
    def _densify(coords, spacing_m=50.0):
        """Add points along road segments so hazard crossing between OSM vertices is detected."""
        if len(coords) < 2:
            return coords
        out = [coords[0]]
        for a, b in zip(coords, coords[1:]):
            d_m = haversine_distance_km(a[1], a[0], b[1], b[0]) * 1000
            steps = max(1, int(d_m / spacing_m))
            for i in range(1, steps + 1):
                f = i / steps
                out.append([a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f])
        return out

    def _evaluate_roads(self, hazard, origin_lat, origin_lng, elapsed, bridge_statuses):
        results = []
        closed_bridge_ids = {b["id"] for b in bridge_statuses if b["is_closed"]}
        closed_bridge_names = {b["name"].lower() for b in self.infrastructure.get("bridges", []) if b["id"] in closed_bridge_ids}

        for road in self.infrastructure.get("roads", []):
            blocked = False
            state = "NONE"
            max_intensity = 0.0
            in_hazard = False
            # Explicit bridge IDs are preferred; legacy name matching remains as a compatibility fallback.
            linked_bridges = set(road.get("bridgeIds", []))
            road_name = road.get("name", "").lower()
            bridge_dependency = bool(linked_bridges & closed_bridge_ids) or any(n and n in road_name for n in closed_bridge_names)

            for pt in self._densify(road.get("coordinates", [])):
                impact = hazard.evaluate_point_impact(pt[1], pt[0], origin_lat, origin_lng, elapsed)
                if impact["in_hazard_zone"]:
                    in_hazard = True
                    max_intensity = max(max_intensity, impact["intensity"])
                    if impact.get("damage_state") not in ("NONE", "EXPOSED"):
                        state = impact["damage_state"]

            # Delayed road blockage:
            # Roads do not instantly become impassable upon initial contact with the expanding hazard envelope.
            # Vehicles can still navigate or evacuate initially. Sustained exposure (debris build-up, deepening water)
            # is required before the road status turns BLOCKED (red).
            if bridge_dependency:
                blocked, state = True, "SEVERE"
            elif in_hazard:
                if road["id"] not in self._road_entry_time:
                    self._road_entry_time[road["id"]] = elapsed

                exposure_seconds = max(0.0, elapsed - self._road_entry_time[road["id"]])
                # Calibrated soak threshold: between 20s and 45s depending on proximity/intensity
                soak_threshold = max(20.0, 45.0 - max_intensity * 25.0)

                if exposure_seconds >= soak_threshold:
                    blocked = True
                    if state in ("NONE", "EXPOSED"):
                        state = "SEVERE" if max_intensity > 0.6 else "MODERATE"
                else:
                    blocked = False
                    if state == "NONE":
                        state = "EXPOSED"
            else:
                self._road_entry_time.pop(road["id"], None)

            key = f"road:{road['id']}"
            new_state = "BLOCKED" if blocked else "OPEN"
            if elapsed > 0:
                self._event_on_transition(key, new_state, {
                    "type": "ROAD_BLOCKED", "roadId": road["id"], "name": road["name"], "damageState": state,
                    "message": f"Road {road['name']} transitioned to {state if blocked else 'OPEN'}."
                })
            else:
                self._previous_states.setdefault(key, new_state)
            results.append({"id": road["id"], "name": road["name"], "blocked": blocked, "damageState": state,
                            "hazardExposure": round(max_intensity, 2), "coordinates": road["coordinates"]})
        return results

    def _evaluate_hospitals(self, hazard, origin_lat, origin_lng, elapsed, power_statuses):
        results = []
        offline_ids = {p["id"] for p in power_statuses if p["status"] == "OFFLINE"}
        severity = hazard.calculate_severity()
        time_growth = 1.0 + max(0, elapsed) / 120.0

        for hosp in self.infrastructure.get("hospitals", []):
            impact = hazard.evaluate_point_impact(hosp["latitude"], hosp["longitude"], origin_lat, origin_lng, elapsed)
            supplied_offline = any(p["id"] in offline_ids and hosp["id"] in p.get("supplies", []) for p in self.infrastructure.get("powerStations", []))
            backup_exhausted = supplied_offline and elapsed > 60

            total_beds = int(hosp["beds"])
            base_avail = int(hosp["availableBeds"])
            total_icu = int(hosp["icuBeds"])
            base_icu = int(hosp["availableIcu"])

            # Physical hazard exposure reduces usable capacity before demand is applied.
            exposure = impact["intensity"] if impact["in_hazard_zone"] else 0.0
            physical_factor = 1.0
            if impact["in_hazard_zone"]:
                if impact.get("damage_state") in ("DESTROYED", "SEVERE"):
                    physical_factor = .20
                elif impact.get("damage_state") == "MODERATE":
                    physical_factor = .55
                else:
                    physical_factor = max(.70, 1.0 - .25 * exposure)
            power_factor = .50 if backup_exhausted else 1.0
            effective_factor = min(physical_factor, power_factor)

            dist_km = haversine_distance_km(hosp["latitude"], hosp["longitude"], origin_lat, origin_lng)
            proximity = max(.0, 1.0 - dist_km / 12.0)
            influx = int(base_avail * .45 * (severity / 3.0) * max(.2, proximity) * min(3.0, time_growth))
            avail_beds = max(0, int(base_avail * effective_factor) - influx)
            avail_icu = max(0, int(base_icu * effective_factor) - int(influx * .30))
            occupancy = min(1.0, 1.0 - avail_beds / max(1, total_beds))

            if physical_factor <= .20:
                status = "DAMAGED"
            elif avail_beds == 0 or occupancy >= .96:
                status = "FULL"
            elif backup_exhausted or physical_factor < 1.0:
                status = "COMPROMISED"
            elif occupancy > .82:
                status = "STRESSED"
            elif occupancy > .65:
                status = "NEAR_CAPACITY"
            else:
                status = "OPERATIONAL"

            key = f"hospital:{hosp['id']}"
            if elapsed > 0:
                self._event_on_transition(key, status, {
                    "type": "HOSPITAL_STATUS_CHANGED", "hospitalId": hosp["id"], "name": hosp["name"], "status": status,
                    "message": f"Hospital {hosp['name']} transitioned to {status}."
                })
            else:
                self._previous_states.setdefault(key, status)

            results.append({"id": hosp["id"], "name": hosp["name"], "latitude": hosp["latitude"], "longitude": hosp["longitude"],
                            "beds": total_beds, "availableBeds": avail_beds, "icuBeds": total_icu, "availableIcu": avail_icu,
                            "powerStatus": "BACKUP_GENERATOR" if supplied_offline else "GRID",
                            "operationalStatus": status, "occupancyPct": round(occupancy * 100, 1), "address": hosp.get("address", "")})
        return results

    def _evaluate_shelters(self, hazard, origin_lat, origin_lng, elapsed, roads):
        results = []
        severity = hazard.calculate_severity()
        time_growth = min(2.5, 1.0 + max(0, elapsed) / 150.0)
        blocked_roads = [r for r in roads if r["blocked"]]

        for shelter in self.infrastructure.get("shelters", []):
            impact = hazard.evaluate_point_impact(shelter["latitude"], shelter["longitude"], origin_lat, origin_lng, elapsed)
            capacity, base_occ = int(shelter["capacity"]), int(shelter["occupancy"])
            influx = int(capacity * .15 * (severity / 2.5) * time_growth)
            occupancy = min(capacity, base_occ + influx)
            remaining = max(0, capacity - occupancy)

            physically_unsafe = impact["in_hazard_zone"] and impact.get("damage_state") in ("SEVERE", "DESTROYED")
            inaccessible = physically_unsafe or (impact["in_hazard_zone"] and impact["blocked"])
            status = "INACCESSIBLE" if inaccessible else ("FULL" if remaining == 0 else "OPERATIONAL")
            key = f"shelter:{shelter['id']}"
            if elapsed > 0:
                self._event_on_transition(key, status, {
                    "type": "SHELTER_STATUS_CHANGED", "shelterId": shelter["id"], "name": shelter["name"], "status": status,
                    "message": f"Shelter {shelter['name']} transitioned to {status}."
                })
            else:
                self._previous_states.setdefault(key, status)
            results.append({"id": shelter["id"], "name": shelter["name"], "latitude": shelter["latitude"], "longitude": shelter["longitude"],
                            "capacity": capacity, "occupancy": occupancy, "remainingCapacity": remaining, "status": status,
                            "occupancyPct": round(occupancy / max(1, capacity) * 100, 1), "address": shelter.get("address", "")})
        return results
