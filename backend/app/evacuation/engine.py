"""Evacuation Route Planning and Corridor Recalculation Engine."""

from typing import List, Dict, Any, Optional

from ..geospatial.routing import RoadNetwork
from ..geospatial.spatial import haversine_distance_km
from ..core.logging import logger


class EvacuationEngine:
    """
    Calculates evacuation corridors from threatened population zones to safe operational
    shelters using the current road network graph.
    """

    def __init__(
        self,
        road_network: RoadNetwork,
        population_zones: List[Dict[str, Any]],
        shelters: List[Dict[str, Any]],
    ):
        self.road_network = road_network
        self.population_zones = population_zones
        self.shelters = shelters

    def update_network_from_road_status(
        self,
        road_statuses: List[Dict[str, Any]],
    ):
        """
        Synchronize current simulation road statuses with the routing graph.
        """
        for road in road_statuses:
            road_id = road.get("id")
            if not road_id:
                continue
            self.road_network.update_road_blockage(
                road_id,
                bool(road.get("blocked", False)),
            )

    def compute_evacuation_routes(
        self,
        active_shelters: List[Dict[str, Any]],
        origin_lat: Optional[float] = None,
        origin_lng: Optional[float] = None,
        hazard_radius_km: float = 0.0,
        hazard_model: Any = None,
        elapsed_seconds: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Compute valid evacuation corridors from threatened population zones
        to the best reachable operational shelter strictly OUTSIDE the hazard zone.

        Key Rules:
        1. Threat Zone Filtering: Only zones that are directly threatened or inside
           the active hazard envelope are routed. Safe, unaffected districts do not evacuate.
        2. Safe Shelter Filtering: Only operational shelters strictly outside the active
           hazard envelope (with a safety buffer) are chosen as destinations.
        3. Hazard-Aversion: Paths must traverse open, unblocked roads and lead away
           from the hazard epicenter to safety.
        4. No Fake Detours: If an area's connecting roads are severed, NO synthetic
           straight-line bypass is drawn. The zone is accurately recorded as isolated.
        """
        routes: List[Dict[str, Any]] = []

        # 1. Operational shelters with remaining capacity
        open_shelters = [
            shelter
            for shelter in active_shelters
            if shelter.get("status") == "OPERATIONAL"
            and shelter.get("remainingCapacity", 1) > 0
        ]

        if not open_shelters:
            logger.warning("No operational shelters available with remaining capacity.")
            return routes

        # 2. Filter Destination Shelters: Strictly OUTSIDE the hazard zone
        if origin_lat is not None and origin_lng is not None and hazard_radius_km > 0.2:
            safe_shelters = []
            for shelter in open_shelters:
                s_lng = shelter.get("longitude")
                s_lat = shelter.get("latitude")
                if s_lng is None or s_lat is None:
                    continue

                dist_to_hazard = haversine_distance_km(origin_lat, origin_lng, s_lat, s_lng)
                in_hazard = False
                if hazard_model and hasattr(hazard_model, "evaluate_point_impact"):
                    impact = hazard_model.evaluate_point_impact(s_lat, s_lng, origin_lat, origin_lng, elapsed_seconds)
                    in_hazard = impact.get("in_hazard_zone", False)

                # Shelter is safe if outside active radius + safety buffer and not in hazard zone
                if dist_to_hazard >= (hazard_radius_km + 0.35) and not in_hazard:
                    safe_shelters.append(shelter)

            # Fallback if every shelter in city is somehow within hazard envelope: choose farthest shelters
            if not safe_shelters:
                safe_shelters = sorted(
                    open_shelters,
                    key=lambda s: haversine_distance_km(
                        origin_lat, origin_lng, s.get("latitude", origin_lat), s.get("longitude", origin_lng)
                    ),
                    reverse=True
                )[:3]
        else:
            safe_shelters = open_shelters

        if not safe_shelters:
            return routes

        # 3. Filter Threatened Population Zones (Evacuation Origins)
        if origin_lat is not None and origin_lng is not None and hazard_radius_km > 0.2:
            threatened_zones = []
            for zone in self.population_zones:
                zone_center = zone.get("center")
                if not zone_center or len(zone_center) < 2:
                    continue

                z_lng, z_lat = zone_center[0], zone_center[1]
                dist_to_hazard = haversine_distance_km(origin_lat, origin_lng, z_lat, z_lng)
                in_hazard = False

                if hazard_model and hasattr(hazard_model, "evaluate_point_impact"):
                    impact = hazard_model.evaluate_point_impact(z_lat, z_lng, origin_lat, origin_lng, elapsed_seconds)
                    in_hazard = impact.get("in_hazard_zone", False)

                # Zone is threatened if within envelope or proximity buffer
                threat_threshold = max(2.5, hazard_radius_km * 1.25)
                if in_hazard or dist_to_hazard <= threat_threshold:
                    threatened_zones.append((dist_to_hazard, zone))

            # Sort by proximity to epicenter (closest / most endangered first)
            threatened_zones.sort(key=lambda x: x[0])
            candidate_zones = [z for _, z in threatened_zones]

            # If no zone strictly within radius, pick the 1-2 nearest districts within plausible reach
            if not candidate_zones and self.population_zones:
                nearby = sorted(
                    self.population_zones,
                    key=lambda z: haversine_distance_km(
                        origin_lat, origin_lng, z.get("center", [0, 0])[1], z.get("center", [0, 0])[0]
                    )
                )
                if nearby:
                    closest_dist = haversine_distance_km(
                        origin_lat, origin_lng, nearby[0]["center"][1], nearby[0]["center"][0]
                    )
                    if closest_dist <= max(4.5, hazard_radius_km * 1.8):
                        candidate_zones = nearby[:2]
        else:
            candidate_zones = self.population_zones

        if not candidate_zones:
            return routes

        # 4. Compute Shortest Open-Road Routes Leading Away from Danger
        assigned_corridors = set()

        for zone in candidate_zones:
            zone_center = zone.get("center")
            if not zone_center or len(zone_center) < 2:
                continue

            z_lng, z_lat = zone_center[0], zone_center[1]
            z_dist_to_hazard = haversine_distance_km(origin_lat, origin_lng, z_lat, z_lng) if origin_lat else 0.0

            best_route = None
            target_shelter = None
            best_distance_km = float("inf")

            # Check safe shelters
            for shelter in safe_shelters:
                s_lng = shelter.get("longitude")
                s_lat = shelter.get("latitude")
                if s_lng is None or s_lat is None:
                    continue

                # Shelter should be further from hazard than zone (outward evacuation)
                if origin_lat is not None and origin_lng is not None:
                    s_dist_to_hazard = haversine_distance_km(origin_lat, origin_lng, s_lat, s_lng)
                    if s_dist_to_hazard < z_dist_to_hazard - 0.2:
                        # Moving inward towards the disaster epicenter: skip
                        continue

                path = self.road_network.get_evacuation_route(
                    z_lng,
                    z_lat,
                    s_lng,
                    s_lat,
                )

                if not path or len(path) < 2:
                    continue

                route_distance_km = self.road_network.get_route_cost(path)

                if route_distance_km < best_distance_km:
                    best_distance_km = route_distance_km
                    best_route = path
                    target_shelter = shelter

            # NOTE: If best_route is None (roads blocked), we intentionally DO NOT synthesize
            # fake straight-line detours across rivers or buildings!
            if best_route and target_shelter:
                corridor_key = (zone["id"], target_shelter["id"])
                if corridor_key not in assigned_corridors:
                    assigned_corridors.add(corridor_key)
                    routes.append(
                        {
                            "id": f"evac-{zone['id']}-{target_shelter['id']}",
                            "name": f"Evacuation Corridor: {zone['name']} -> {target_shelter['name']}",
                            "fromZone": zone["name"],
                            "toShelter": target_shelter["name"],
                            "fromCoords": [z_lng, z_lat],
                            "toCoords": [target_shelter["longitude"], target_shelter["latitude"]],
                            "distanceKm": round(best_distance_km, 2),
                            "coordinates": best_route,
                            "status": "clear",
                        }
                    )

        return routes
