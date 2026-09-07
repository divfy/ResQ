"""Spatial math and geometry helpers for disaster calculations."""

import math
from typing import List, Tuple

EARTH_RADIUS_KM = 6371.0

def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points on the Earth in kilometers."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_KM * c

def point_in_bbox(lat: float, lon: float, bbox: List[float]) -> bool:
    """Check if point is inside bounding box [min_lon, min_lat, max_lon, max_lat]."""
    min_lon, min_lat, max_lon, max_lat = bbox
    return (min_lon <= lon <= max_lon) and (min_lat <= lat <= max_lat)

def create_hazard_circle_polygon(center_lng: float, center_lat: float, radius_km: float, num_points: int = 32) -> List[List[float]]:
    """Generate GeoJSON Polygon coordinates for a hazard circular impact zone."""
    coords = []
    # 1 deg latitude is approx 111 km
    lat_deg_per_km = 1.0 / 110.574
    # 1 deg longitude depends on latitude
    lon_deg_per_km = 1.0 / (111.320 * math.cos(math.radians(center_lat)))

    for i in range(num_points + 1):
        angle = (i / num_points) * 2.0 * math.pi
        # Introduce subtle organic contour variation
        variance = 1.0 + 0.12 * math.sin(angle * 3.0) + 0.08 * math.cos(angle * 2.0)
        r = radius_km * variance
        pt_lat = center_lat + (math.sin(angle) * r * lat_deg_per_km)
        pt_lon = center_lng + (math.cos(angle) * r * lon_deg_per_km)
        coords.append([round(pt_lon, 6), round(pt_lat, 6)])

    return coords

def create_tsunami_inundation_polygon(
    target_lng: float,
    target_lat: float,
    progress: float = 1.0,
    num_steps: int = 28
) -> List[List[float]]:
    """
    Generate GeoJSON Polygon coordinates for an oceanic tsunami surge.
    The surge originates in the Bay of Bengal (east/right) and flows inland
    westward across the coast towards the target pinpoint.
    """
    ocean_lng = max(80.36, target_lng + 0.07)
    lat_span = 0.115
    progress = max(0.05, min(1.0, progress))

    coords = []
    # 1. Northeast corner anchored in ocean
    coords.append([ocean_lng, round(target_lat + lat_span, 6)])
    # 2. Southeast corner anchored in ocean
    coords.append([ocean_lng, round(target_lat - lat_span, 6)])

    # 3. Wave surge front advancing westward from South to North
    for i in range(num_steps + 1):
        y = -1.0 + 2.0 * i / num_steps
        pt_lat = round(target_lat + y * lat_span, 6)
        # Parabolic apex at y=0 (target_lat) with subtle wave undulation
        inland_factor = max(0.12, (1.0 - 0.38 * (y ** 2)) + 0.012 * math.sin(y * 5.0 * math.pi))
        pt_lng = round(ocean_lng - (ocean_lng - target_lng) * progress * inland_factor, 6)
        coords.append([pt_lng, pt_lat])

    # 4. Close the polygon back to the first point
    coords.append(coords[0])
    return coords
