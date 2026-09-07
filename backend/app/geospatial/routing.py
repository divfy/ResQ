"""Road Network Graph and Routing Engine using NetworkX."""

import math
import networkx as nx
from typing import List, Dict, Any, Tuple, Optional

from .spatial import haversine_distance_km
from ..core.logging import logger


class RoadNetwork:
    """
    Road network used for evacuation routing.

    The graph is built from the actual road LineString geometry.
    Roads are split at intersections so crossing roads become connected.
    Start/end locations are snapped to the nearest point on a road,
    rather than simply to the nearest road vertex.
    """

    MAX_SNAP_DISTANCE_KM = 8.0
    INTERSECTION_TOLERANCE_DEG = 1e-9

    def __init__(self, roads_data: List[Dict[str, Any]]):
        self.roads_data = roads_data

        self.graph = nx.Graph()

        # node_id -> (lng, lat)
        self.node_coords: Dict[str, Tuple[float, float]] = {}

        # (u, v) -> road_id
        self.edge_roads: Dict[Tuple[str, str], str] = {}

        self._build_graph()

    # ------------------------------------------------------------------
    # BASIC GEOMETRY HELPERS
    # ------------------------------------------------------------------

    @staticmethod
    def _node_id(lng: float, lat: float) -> str:
        """
        Stable graph node ID.

        7 decimal places gives enough precision for road geometry while
        avoiding floating-point noise creating duplicate nodes.
        """
        return f"{round(lng, 7)}_{round(lat, 7)}"

    @staticmethod
    def _orientation(
        ax: float,
        ay: float,
        bx: float,
        by: float,
        cx: float,
        cy: float,
    ) -> float:
        """2D cross product used for segment intersection tests."""
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

    @classmethod
    def _segment_intersection(
        cls,
        a: Tuple[float, float],
        b: Tuple[float, float],
        c: Tuple[float, float],
        d: Tuple[float, float],
    ) -> Optional[Tuple[float, float]]:
        """
        Return the intersection point of two line segments.

        Coordinates are treated as a local 2D plane. This is appropriate
        for the very small distances represented by individual road
        segments.

        Returns None when the segments do not cross.
        """

        ax, ay = a
        bx, by = b
        cx, cy = c
        dx, dy = d

        denominator = (
            (ax - bx) * (cy - dy)
            - (ay - by) * (cx - dx)
        )

        if abs(denominator) < cls.INTERSECTION_TOLERANCE_DEG:
            # Parallel or collinear.
            return None

        t = (
            (ax - cx) * (cy - dy)
            - (ay - cy) * (cx - dx)
        ) / denominator

        u = -(
            (ax - bx) * (ay - cy)
            - (ay - by) * (ax - cx)
        ) / denominator

        tolerance = 1e-9

        if (
            -tolerance <= t <= 1 + tolerance
            and -tolerance <= u <= 1 + tolerance
        ):
            lng = ax + t * (bx - ax)
            lat = ay + t * (by - ay)

            return lng, lat

        return None

    @staticmethod
    def _point_to_segment_projection(
        point: Tuple[float, float],
        a: Tuple[float, float],
        b: Tuple[float, float],
    ) -> Tuple[float, float, float]:
        """
        Project a point onto a line segment.

        Returns:
            projected_lng,
            projected_lat,
            parameter_t

        t=0 means A.
        t=1 means B.
        """

        px, py = point
        ax, ay = a
        bx, by = b

        dx = bx - ax
        dy = by - ay

        segment_length_squared = dx * dx + dy * dy

        if segment_length_squared == 0:
            return ax, ay, 0.0

        t = (
            (px - ax) * dx
            + (py - ay) * dy
        ) / segment_length_squared

        t = max(0.0, min(1.0, t))

        projected_x = ax + t * dx
        projected_y = ay + t * dy

        return projected_x, projected_y, t

    # ------------------------------------------------------------------
    # GRAPH CONSTRUCTION
    # ------------------------------------------------------------------

    def _build_graph(self):
        """
        Build a graph from the supplied road LineStrings.

        Every road segment is split at:
        - its original vertices
        - intersections with other roads

        This is what allows routing to move correctly from one road
        to another at an actual physical intersection.
        """

        road_segments = []

        for road in self.roads_data:
            road_id = road["id"]
            coords = road.get("coordinates", [])

            if len(coords) < 2:
                logger.warning(
                    "Skipping road %s because it has fewer than two points.",
                    road_id,
                )
                continue

            speed = max(
                10.0,
                float(road.get("speedKmh", 50)),
            )

            blocked = bool(
                road.get("blocked", False)
            )

            for i in range(len(coords) - 1):
                start = (
                    float(coords[i][0]),
                    float(coords[i][1]),
                )

                end = (
                    float(coords[i + 1][0]),
                    float(coords[i + 1][1]),
                )

                if start == end:
                    continue

                road_segments.append(
                    {
                        "road_id": road_id,
                        "start": start,
                        "end": end,
                        "speed": speed,
                        "blocked": blocked,
                    }
                )

        # Every segment initially contains its two original endpoints.
        split_points: Dict[int, List[Tuple[float, float]]] = {}

        for index, segment in enumerate(road_segments):
            split_points[index] = [
                segment["start"],
                segment["end"],
            ]

        # --------------------------------------------------------------
        # FIND ROAD INTERSECTIONS
        # --------------------------------------------------------------

        for i in range(len(road_segments)):
            segment_a = road_segments[i]

            for j in range(i + 1, len(road_segments)):
                segment_b = road_segments[j]

                # Segments belonging to the same road already have their
                # shared vertices represented, so no need to test them.
                if segment_a["road_id"] == segment_b["road_id"]:
                    continue

                sa_start, sa_end = segment_a["start"], segment_a["end"]
                sb_start, sb_end = segment_b["start"], segment_b["end"]

                # Fast bounding-box overlap rejection
                min_ax, max_ax = (sa_start[0], sa_end[0]) if sa_start[0] < sa_end[0] else (sa_end[0], sa_start[0])
                min_bx, max_bx = (sb_start[0], sb_end[0]) if sb_start[0] < sb_end[0] else (sb_end[0], sb_start[0])
                if max_ax < min_bx or min_ax > max_bx:
                    continue

                min_ay, max_ay = (sa_start[1], sa_end[1]) if sa_start[1] < sa_end[1] else (sa_end[1], sa_start[1])
                min_by, max_by = (sb_start[1], sb_end[1]) if sb_start[1] < sb_end[1] else (sb_end[1], sb_start[1])
                if max_ay < min_by or min_ay > max_by:
                    continue

                intersection = self._segment_intersection(
                    sa_start,
                    sa_end,
                    sb_start,
                    sb_end,
                )

                if intersection is not None:
                    split_points[i].append(intersection)
                    split_points[j].append(intersection)

        # --------------------------------------------------------------
        # CREATE SPLIT ROAD EDGES
        # --------------------------------------------------------------

        for index, segment in enumerate(road_segments):
            points = split_points[index]

            start = segment["start"]
            end = segment["end"]

            # Sort points along the original road segment.
            points = sorted(
                points,
                key=lambda point: (
                    (point[0] - start[0]) ** 2
                    + (point[1] - start[1]) ** 2
                ),
            )

            # Remove duplicate points.
            unique_points = []

            for point in points:
                if not unique_points:
                    unique_points.append(point)
                    continue

                previous = unique_points[-1]

                if (
                    abs(point[0] - previous[0]) > 1e-9
                    or abs(point[1] - previous[1]) > 1e-9
                ):
                    unique_points.append(point)

            for i in range(len(unique_points) - 1):
                point_a = unique_points[i]
                point_b = unique_points[i + 1]

                node_a = self._node_id(
                    point_a[0],
                    point_a[1],
                )

                node_b = self._node_id(
                    point_b[0],
                    point_b[1],
                )

                self.node_coords[node_a] = point_a
                self.node_coords[node_b] = point_b

                distance_km = haversine_distance_km(
                    point_a[1],
                    point_a[0],
                    point_b[1],
                    point_b[0],
                )

                speed = segment["speed"]

                travel_time_hours = (
                    distance_km / speed
                    if speed > 0
                    else float("inf")
                )

                self.graph.add_edge(
                    node_a,
                    node_b,
                    road_id=segment["road_id"],
                    length_km=distance_km,
                    speed_kmh=speed,
                    weight=travel_time_hours,
                    blocked=segment["blocked"],
                )

                self.edge_roads[
                    (node_a, node_b)
                ] = segment["road_id"]

                self.edge_roads[
                    (node_b, node_a)
                ] = segment["road_id"]

    # ------------------------------------------------------------------
    # ROAD STATUS
    # ------------------------------------------------------------------

    def update_road_blockage(
        self,
        road_id: str,
        blocked: bool,
    ):
        """
        Update every graph edge belonging to a road.
        """

        for _, _, data in self.graph.edges(data=True):
            if data.get("road_id") != road_id:
                continue

            data["blocked"] = bool(blocked)

    # ------------------------------------------------------------------
    # TRAVERSABLE GRAPH
    # ------------------------------------------------------------------

    def _get_traversable_graph(self) -> nx.Graph:
        """
        Return a graph containing only open road segments.
        """

        graph = nx.Graph()

        graph.add_nodes_from(
            self.graph.nodes(data=True)
        )

        for u, v, data in self.graph.edges(data=True):
            if data.get("blocked", False):
                continue

            graph.add_edge(
                u,
                v,
                **data,
            )

        return graph

    # ------------------------------------------------------------------
    # NEAREST POINT ON ROAD
    # ------------------------------------------------------------------

    def _find_nearest_road_point(
        self,
        lng: float,
        lat: float,
        graph: nx.Graph,
    ) -> Optional[Dict[str, Any]]:
        """
        Find the closest point on any currently traversable road segment.

        This is more accurate than snapping to the nearest road vertex.
        """

        if graph.number_of_edges() == 0:
            return None

        best = None
        best_distance = float("inf")

        for u, v, data in graph.edges(data=True):

            point_a = self.node_coords[u]
            point_b = self.node_coords[v]

            projected_lng, projected_lat, t = (
                self._point_to_segment_projection(
                    (lng, lat),
                    point_a,
                    point_b,
                )
            )

            distance_km = haversine_distance_km(
                lat,
                lng,
                projected_lat,
                projected_lng,
            )

            if distance_km < best_distance:
                best_distance = distance_km

                best = {
                    "u": u,
                    "v": v,
                    "lng": projected_lng,
                    "lat": projected_lat,
                    "distance_km": distance_km,
                    "t": t,
                    "edge_data": data,
                }

        if best is None:
            return None

        if best["distance_km"] > self.MAX_SNAP_DISTANCE_KM:
            return None

        return best

    # ------------------------------------------------------------------
    # TEMPORARY ROUTING NODES
    # ------------------------------------------------------------------

    def _connect_point_to_road(
        self,
        graph: nx.Graph,
        point: Dict[str, Any],
        prefix: str,
    ) -> str:
        """
        Insert a temporary routing node at the exact projected point
        on a road segment.

        The original road edge is split into:
            road start -> projected point -> road end
        """

        u = point["u"]
        v = point["v"]

        lng = point["lng"]
        lat = point["lat"]

        # If the projected point is already an endpoint, reuse it.
        if point["t"] <= 1e-8:
            return u

        if point["t"] >= 1 - 1e-8:
            return v

        node = f"{prefix}_{self._node_id(lng, lat)}"

        self.node_coords[node] = (
            lng,
            lat,
        )

        edge_data = graph.get_edge_data(u, v)

        if edge_data is None:
            return node

        total_distance = edge_data["length_km"]
        speed = edge_data.get("speed_kmh", 50)

        distance_u = total_distance * point["t"]
        distance_v = total_distance * (1 - point["t"])

        time_u = distance_u / speed
        time_v = distance_v / speed

        # Remove original segment.
        graph.remove_edge(u, v)

        # Connect U -> projected point.
        graph.add_edge(
            u,
            node,
            road_id=edge_data["road_id"],
            length_km=distance_u,
            speed_kmh=speed,
            weight=time_u,
            blocked=False,
        )

        # Connect projected point -> V.
        graph.add_edge(
            node,
            v,
            road_id=edge_data["road_id"],
            length_km=distance_v,
            speed_kmh=speed,
            weight=time_v,
            blocked=False,
        )

        return node

    # ------------------------------------------------------------------
    # ROUTING
    # ------------------------------------------------------------------

    def get_evacuation_route(
        self,
        start_lng: float,
        start_lat: float,
        end_lng: float,
        end_lat: float,
    ) -> Optional[List[List[float]]]:
        """
        Find a shortest valid evacuation route using only open roads.

        Start and end coordinates are projected onto actual road
        segments. The resulting route therefore follows road geometry
        instead of drawing arbitrary straight lines.
        """

        graph = self._get_traversable_graph()

        if graph.number_of_edges() == 0:
            return None

        # --------------------------------------------------------------
        # SNAP START TO ACTUAL ROAD SEGMENT
        # --------------------------------------------------------------

        start_point = self._find_nearest_road_point(
            start_lng,
            start_lat,
            graph,
        )

        if start_point is None:
            logger.warning(
                "Could not snap evacuation start point "
                "(%.6f, %.6f) to an open road.",
                start_lng,
                start_lat,
            )
            return None

        # --------------------------------------------------------------
        # SNAP END TO ACTUAL ROAD SEGMENT
        # --------------------------------------------------------------

        end_point = self._find_nearest_road_point(
            end_lng,
            end_lat,
            graph,
        )

        if end_point is None:
            logger.warning(
                "Could not snap evacuation destination "
                "(%.6f, %.6f) to an open road.",
                end_lng,
                end_lat,
            )
            return None

        # --------------------------------------------------------------
        # ADD TEMPORARY START/END NODES
        # --------------------------------------------------------------

        start_node = self._connect_point_to_road(
            graph,
            start_point,
            "START",
        )

        # Recalculate the end projection after potentially modifying
        # the graph for the start point.
        end_point = self._find_nearest_road_point(
            end_lng,
            end_lat,
            graph,
        )

        if end_point is None:
            return None

        end_node = self._connect_point_to_road(
            graph,
            end_point,
            "END",
        )

        if start_node == end_node:
            return [
                list(self.node_coords[start_node])
            ]

        # --------------------------------------------------------------
        # FIND SHORTEST OPEN-ROAD PATH
        # --------------------------------------------------------------

        try:
            path = nx.shortest_path(
                graph,
                source=start_node,
                target=end_node,
                weight="weight",
            )

        except (
            nx.NetworkXNoPath,
            nx.NodeNotFound,
        ):
            return None

        if len(path) < 2:
            return None

        # --------------------------------------------------------------
        # CONVERT GRAPH PATH TO ACTUAL MAP COORDINATES
        # --------------------------------------------------------------

        coordinates = [
            list(self.node_coords[node])
            for node in path
        ]

        return coordinates

    # ------------------------------------------------------------------
    # ROUTE DISTANCE
    # ------------------------------------------------------------------

    def get_route_cost(
        self,
        route: List[List[float]],
    ) -> float:
        """
        Return total route distance in kilometres.
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
