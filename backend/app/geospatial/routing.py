"""Road Network Graph and Routing Engine using NetworkX."""

import networkx as nx
from typing import List, Dict, Any, Tuple, Optional

from .spatial import haversine_distance_km
from ..core.logging import logger


class RoadNetwork:
    """
    Road-network graph used for evacuation routing.

    Blocked roads are excluded from the traversable graph entirely.
    This ensures routing searches for a genuine alternate path rather
    than selecting a blocked road and rejecting the result afterward.
    """

    # Prevent a population zone or shelter from being snapped to a road
    # that is unrealistically far away.
    MAX_SNAP_DISTANCE_KM = 5.0

    def __init__(self, roads_data: List[Dict[str, Any]]):
        self.roads_data = roads_data

        # Full graph contains all roads, including blocked ones.
        self.graph = nx.Graph()

        # node_id -> (lng, lat)
        self.node_coords: Dict[str, Tuple[float, float]] = {}

        # (u, v) -> road_id
        self.edge_roads: Dict[Tuple[str, str], str] = {}

        self._build_graph()

    @staticmethod
    def _node_id(point: List[float]) -> str:
        """Create a stable node ID from [lng, lat]."""
        return f"{round(point[0], 5)}_{round(point[1], 5)}"

    def _build_graph(self):
        """Construct the NetworkX graph from road line segments."""

        for road in self.roads_data:
            road_id = road["id"]
            coords = road.get("coordinates", [])
            speed = max(10.0, float(road.get("speedKmh", 50)))
            is_blocked = bool(road.get("blocked", False))

            if len(coords) < 2:
                logger.warning(
                    "Skipping road %s because it has fewer than two coordinates.",
                    road_id,
                )
                continue

            for i in range(len(coords) - 1):
                pt1 = coords[i]
                pt2 = coords[i + 1]

                node1 = self._node_id(pt1)
                node2 = self._node_id(pt2)

                self.node_coords[node1] = (pt1[0], pt1[1])
                self.node_coords[node2] = (pt2[0], pt2[1])

                dist_km = haversine_distance_km(
                    pt1[1],
                    pt1[0],
                    pt2[1],
                    pt2[0],
                )

                # Travel time in hours.
                travel_time_hours = dist_km / speed

                # Use travel time as the routing weight.
                # Shorter/faster routes are therefore preferred.
                weight = travel_time_hours

                self.graph.add_edge(
                    node1,
                    node2,
                    road_id=road_id,
                    length_km=dist_km,
                    speed_kmh=speed,
                    weight=weight,
                    blocked=is_blocked,
                )

                self.edge_roads[(node1, node2)] = road_id
                self.edge_roads[(node2, node1)] = road_id

    def update_road_blockage(self, road_id: str, blocked: bool):
        """
        Update blocked status of every graph edge belonging to road_id.

        We keep the edge in the full graph so its state can change again
        later during the simulation. Traversability is handled by
        _get_traversable_graph().
        """

        for _, _, data in self.graph.edges(data=True):
            if data.get("road_id") == road_id:
                data["blocked"] = bool(blocked)

    def _get_traversable_graph(self) -> nx.Graph:
        """
        Return a graph containing ONLY currently traversable road edges.

        Blocked roads are physically absent from this graph. This is
        important because giving blocked roads a huge weight is not enough:
        Dijkstra can still use them if no cheaper path exists.
        """

        traversable = nx.Graph()

        # Preserve nodes/coordinates so isolated-but-valid nodes can still
        # be considered by NetworkX.
        traversable.add_nodes_from(self.graph.nodes(data=True))

        for u, v, data in self.graph.edges(data=True):
            if data.get("blocked", False):
                continue

            traversable.add_edge(u, v, **data)

        return traversable

    def find_nearest_node(
        self,
        lng: float,
        lat: float,
        graph: Optional[nx.Graph] = None,
        max_distance_km: Optional[float] = None,
    ) -> Optional[str]:
        """
        Find the nearest usable graph node.

        If a traversable graph is supplied, nodes that have no usable road
        connection are ignored.
        """

        if graph is None:
            graph = self.graph

        if max_distance_km is None:
            max_distance_km = self.MAX_SNAP_DISTANCE_KM

        if graph.number_of_nodes() == 0:
            return None

        min_dist = float("inf")
        nearest = None

        for node in graph.nodes:
            # A node with no traversable edges is not useful for routing.
            if graph.degree(node) == 0:
                continue

            node_coords = self.node_coords.get(node)

            if node_coords is None:
                continue

            n_lng, n_lat = node_coords

            distance = haversine_distance_km(
                lat,
                lng,
                n_lat,
                n_lng,
            )

            if distance < min_dist:
                min_dist = distance
                nearest = node

        if nearest is None:
            return None

        # Don't snap a zone/shelter to a completely unrelated road.
        if min_dist > max_distance_km:
            return None

        return nearest

    def get_evacuation_route(
        self,
        start_lng: float,
        start_lat: float,
        end_lng: float,
        end_lat: float,
    ) -> Optional[List[List[float]]]:
        """
        Find the shortest valid evacuation route between two coordinates.

        Only unblocked roads are considered.

        Returns:
            List of [lng, lat] coordinates representing the route,
            or None when no valid route exists.
        """

        # Build a graph containing ONLY open roads.
        traversable_graph = self._get_traversable_graph()

        if traversable_graph.number_of_edges() == 0:
            return None

        # Snap both endpoints to usable road nodes.
        start_node = self.find_nearest_node(
            start_lng,
            start_lat,
            graph=traversable_graph,
        )

        end_node = self.find_nearest_node(
            end_lng,
            end_lat,
            graph=traversable_graph,
        )

        if start_node is None or end_node is None:
            return None

        if start_node == end_node:
            # Both endpoints snapped to the same road node.
            return [
                list(self.node_coords[start_node])
            ]

        try:
            path = nx.shortest_path(
                traversable_graph,
                source=start_node,
                target=end_node,
                weight="weight",
            )

        except (nx.NetworkXNoPath, nx.NodeNotFound):
            # There is genuinely no connected open-road route.
            return None

        if len(path) < 2:
            return None

        # Convert graph nodes back to [lng, lat].
        coords = [
            list(self.node_coords[node])
            for node in path
        ]

        return coords

    def get_route_cost(
        self,
        route: List[List[float]],
    ) -> float:
        """
        Calculate approximate route distance in kilometres.

        Used by the evacuation engine to compare multiple reachable
        shelters.
        """

        if not route or len(route) < 2:
            return 0.0

        total_distance = 0.0

        for i in range(len(route) - 1):
            lng1, lat1 = route[i]
            lng2, lat2 = route[i + 1]

            total_distance += haversine_distance_km(
                lat1,
                lng1,
                lat2,
                lng2,
            )

        return total_distance
