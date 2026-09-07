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


def calculate_cyclone_track(origin_lat: float, origin_lng: float, progress: float = 1.0, total_steps: int = 32) -> List[List[float]]:
    """
    Generate parametric C-shaped cyclone trajectory starting at (origin_lng, origin_lat).
    The cyclone moves westward across the city and recurves back toward the ocean / east.
    """
    progress = max(0.0, min(1.0, progress))
    steps = max(1, int(total_steps * progress))
    track = []
    A = 0.10  # Westward inland penetration (~11 km)
    L = 0.13  # Northward track progression (~14.5 km)

    for i in range(steps + 1):
        u = (i / total_steps) * progress if total_steps > 0 else 0.0
        pt_lng = origin_lng - A * math.sin(math.pi * u)
        pt_lat = origin_lat + L * (1.15 * u - 0.15 * (u ** 2))
        track.append([round(pt_lng, 6), round(pt_lat, 6)])

    if not track:
        track.append([round(origin_lng, 6), round(origin_lat, 6)])
    return track


def min_distance_to_track_km(p_lat: float, p_lng: float, track_points: List[List[float]]) -> float:
    """Calculate minimum distance from point (p_lat, p_lng) to a polyline track."""
    if not track_points:
        return 999999.0
    if len(track_points) == 1:
        return haversine_distance_km(p_lat, p_lng, track_points[0][1], track_points[0][0])

    min_dist = 999999.0
    for i in range(len(track_points) - 1):
        a_lng, a_lat = track_points[i]
        b_lng, b_lat = track_points[i + 1]

        cos_lat = math.cos(math.radians((a_lat + b_lat) / 2.0))
        bx = (b_lng - a_lng) * 111.320 * cos_lat
        by = (b_lat - a_lat) * 110.574
        px = (p_lng - a_lng) * 111.320 * cos_lat
        py = (p_lat - a_lat) * 110.574

        seg_len_sq = bx * bx + by * by
        t = 0.0 if seg_len_sq <= 1e-6 else max(0.0, min(1.0, (px * bx + py * by) / seg_len_sq))

        cx = t * bx
        cy = t * by
        dist = math.hypot(px - cx, py - cy)
        if dist < min_dist:
            min_dist = dist

    return min_dist


def create_swept_swath_polygon(track_points: List[List[float]], radius_km: float = 5.0, num_cap_pts: int = 8) -> List[List[float]]:
    """
    Generate GeoJSON Polygon coordinates for the continuous hazard corridor (swept swath)
    along the cyclone polyline path.
    """
    if not track_points:
        return []
    if len(track_points) == 1:
        return create_hazard_circle_polygon(track_points[0][0], track_points[0][1], radius_km, 24)

    left_pts = []
    right_pts = []

    for i in range(len(track_points)):
        c_lng, c_lat = track_points[i]
        lat_deg = radius_km / 110.574
        lon_deg = radius_km / (111.320 * math.cos(math.radians(c_lat)))

        if i == 0:
            dx = (track_points[1][0] - c_lng) / lon_deg
            dy = (track_points[1][1] - c_lat) / lat_deg
        elif i == len(track_points) - 1:
            dx = (c_lng - track_points[i - 1][0]) / lon_deg
            dy = (c_lat - track_points[i - 1][1]) / lat_deg
        else:
            dx = (track_points[i + 1][0] - track_points[i - 1][0]) / lon_deg
            dy = (track_points[i + 1][1] - track_points[i - 1][1]) / lat_deg

        length = math.hypot(dx, dy) or 1.0
        nx = -dy / length
        ny = dx / length

        left_pts.append([round(c_lng + nx * lon_deg, 6), round(c_lat + ny * lat_deg, 6)])
        right_pts.append([round(c_lng - nx * lon_deg, 6), round(c_lat - ny * lat_deg, 6)])

    coords = list(left_pts)

    # Semicircular cap at the active eye (end)
    end_lng, end_lat = track_points[-1]
    end_lat_deg = radius_km / 110.574
    end_lon_deg = radius_km / (111.320 * math.cos(math.radians(end_lat)))
    start_ang = math.atan2((left_pts[-1][1] - end_lat) / end_lat_deg, (left_pts[-1][0] - end_lng) / end_lon_deg)
    end_ang = math.atan2((right_pts[-1][1] - end_lat) / end_lat_deg, (right_pts[-1][0] - end_lng) / end_lon_deg)
    if end_ang > start_ang:
        end_ang -= 2.0 * math.pi
    for j in range(1, num_cap_pts):
        a = start_ang + (end_ang - start_ang) * (j / num_cap_pts)
        coords.append([round(end_lng + math.cos(a) * end_lon_deg, 6), round(end_lat + math.sin(a) * end_lat_deg, 6)])

    coords.extend(reversed(right_pts))

    # Semicircular cap at the track start
    s_lng, s_lat = track_points[0]
    s_lat_deg = radius_km / 110.574
    s_lon_deg = radius_km / (111.320 * math.cos(math.radians(s_lat)))
    start_ang_s = math.atan2((right_pts[0][1] - s_lat) / s_lat_deg, (right_pts[0][0] - s_lng) / s_lon_deg)
    end_ang_s = math.atan2((left_pts[0][1] - s_lat) / s_lat_deg, (left_pts[0][0] - s_lng) / s_lon_deg)
    if end_ang_s > start_ang_s:
        end_ang_s -= 2.0 * math.pi
    for j in range(1, num_cap_pts):
        a = start_ang_s + (end_ang_s - start_ang_s) * (j / num_cap_pts)
        coords.append([round(s_lng + math.cos(a) * s_lon_deg, 6), round(s_lat + math.sin(a) * s_lat_deg, 6)])

    coords.append(coords[0])
    return coords
