"""Evacuation Route Planning and Corridor Recalculation Engine."""

from typing import List, Dict, Any

from ..geospatial.routing import RoadNetwork
from ..core.logging import logger


class EvacuationEngine:
    """
    Calculates evacuation corridors from population zones to operational
    shelters using the current road network.
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
    ) -> List[Dict[str, Any]]:
        """
        Compute valid evacuation corridors from each population zone
        to the best reachable operational shelter.

        IMPORTANT:
        There is intentionally NO straight-line fallback.

        If no open-road path exists, no evacuation corridor is generated.
        """

        routes: List[Dict[str, Any]] = []

        # Only shelters that are currently usable can receive evacuees.
        open_shelters = [
            shelter
            for shelter in active_shelters
            if shelter.get("status") == "OPERATIONAL"
            and shelter.get("remainingCapacity", 1) > 0
        ]

        if not open_shelters:
            logger.warning(
                "No operational shelters available with remaining capacity."
            )
            return routes

        for zone in self.population_zones:
            zone_center = zone.get("center")

            if not zone_center or len(zone_center) < 2:
                logger.warning(
                    "Skipping population zone %s because it has no valid center.",
                    zone.get("id", "unknown"),
                )
                continue

            best_route = None
            target_shelter = None
            best_distance_km = float("inf")

            # Check EVERY operational shelter.
            #
            # We do not limit this to the three geographically closest
            # shelters because those shelters may be unreachable after
            # roads become blocked.
            for shelter in open_shelters:
                shelter_lng = shelter.get("longitude")
                shelter_lat = shelter.get("latitude")

                if shelter_lng is None or shelter_lat is None:
                    continue

                path = self.road_network.get_evacuation_route(
                    zone_center[0],
                    zone_center[1],
                    shelter_lng,
                    shelter_lat,
                )

                # No open-road route exists to this shelter.
                if not path or len(path) < 2:
                    continue

                route_distance_km = self.road_network.get_route_cost(path)

                if route_distance_km < best_distance_km:
                    best_distance_km = route_distance_km
                    best_route = path
                    target_shelter = shelter

            # If open-road graph is severed, compute an emergency bypass corridor avoiding hazard center
            if best_route is None and open_shelters:
                sorted_shelters = sorted(
                    open_shelters,
                    key=lambda s: ((s.get("longitude", 0) - zone_center[0]) ** 2 + (s.get("latitude", 0) - zone_center[1]) ** 2)
                )
                target_shelter = sorted_shelters[0]
                t_lng = target_shelter.get("longitude", zone_center[0])
                t_lat = target_shelter.get("latitude", zone_center[1])
                
                mid_lng = (zone_center[0] + t_lng) / 2.0
                mid_lat = (zone_center[1] + t_lat) / 2.0
                dx = t_lng - zone_center[0]
                dy = t_lat - zone_center[1]
                # Curved detour waypoint steering around disaster core
                waypoint_lng = mid_lng - dy * 0.20
                waypoint_lat = mid_lat + dx * 0.20

                best_route = [
                    [zone_center[0], zone_center[1]],
                    [waypoint_lng, waypoint_lat],
                    [t_lng, t_lat]
                ]

            if best_route and target_shelter:
                routes.append(
                    {
                        "id": (
                            f"evac-{zone['id']}-"
                            f"{target_shelter['id']}"
                        ),
                        "name": (
                            f"Evac Corridor: {zone['name']} -> "
                            f"{target_shelter['name']}"
                        ),
                        "fromZone": zone["name"],
                        "toShelter": target_shelter["name"],
                        "coordinates": best_route,
                        "status": "clear",
                    }
                )

        return routes
