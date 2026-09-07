"""Earthquake Disaster Simulation Model."""

import math
from typing import Dict, Any
from .base import BaseDisaster
from ..geospatial.spatial import haversine_distance_km

DEFAULT_QUAKE_PROPS = [
    {"id": "pga", "name": "PEAK GROUND ACCEL (PGA)", "unit": "g", "min": 0.05, "max": 1.25, "step": 0.02, "defaultValue": 0.42},
    {"id": "duration", "name": "SHAKING DURATION", "unit": "s", "min": 5, "max": 120, "step": 1, "defaultValue": 38},
    {"id": "depth", "name": "EPICENTER DEPTH", "unit": "km", "min": 5, "max": 70, "step": 1, "defaultValue": 12}
]

class EarthquakeDisaster(BaseDisaster):
    def __init__(self, properties: Dict[str, float]):
        super().__init__("earthquake", properties, DEFAULT_QUAKE_PROPS)

    def calculate_severity(self) -> float:
        pga = self.properties.get("pga", 0.42)
        dur = self.properties.get("duration", 38.0)
        depth = self.properties.get("depth", 12.0)

        norm_pga = (pga - 0.05) / (1.25 - 0.05)
        norm_dur = (dur - 5.0) / (120.0 - 5.0)
        norm_depth = 1.0 - ((depth - 5.0) / (70.0 - 5.0))  # shallower is more severe

        avg_norm = (norm_pga * 0.55 + norm_dur * 0.25 + norm_depth * 0.20)
        sev = 1.0 + avg_norm * 4.0
        return round(min(5.0, max(1.0, sev)), 2)

    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        """
        Calculates active ground-shaking radius (km):
        - Final maximum size depends strictly on EPICENTER DEPTH: shallower focal depths
          yield wider surface rupture / shaking footprints (up to ~10.5 km at 5 km depth;
          deep focus attenuates down to ~4.0 km at 70 km depth).
        - Speed to attain maximum size depends strictly on PEAK GROUND ACCEL (PGA):
          violent high-PGA quakes reach full extent in ~20s; low-PGA tremors expand slowly (~85s).
        """
        pga = self.properties.get("pga", 0.42)
        depth = max(5.0, self.properties.get("depth", 12.0))

        # 1. Final maximum radius depends exclusively on depth
        max_radius = round(3.5 + (35.0 / depth), 2)

        if elapsed_seconds <= 0:
            return 0.5

        # 2. Time to attain max radius depends exclusively on PGA
        norm_pga = self._clamp((pga - 0.05) / (1.25 - 0.05))
        time_to_max = 85.0 - (norm_pga * 65.0)  # 85s at 0.05g -> 20s at 1.25g

        progress = min(1.0, elapsed_seconds / max(1.0, time_to_max))
        # Quadratic ease-out expansion curve: fast initial P/S-wave shock
        expansion_factor = 1.0 - (1.0 - progress) ** 2
        return round(max(0.5, max_radius * expansion_factor), 2)

    def get_earthquake_zones(
        self,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int
    ) -> list:
        """
        Returns 4 concentric circular seismic intensity zones centered at the epicenter:
        - Red = High (Zone IV / Severe Shaking Core, 20% radius)
        - Dark Orange = Mid (Zone III / Strong Ground Motion, 45% radius)
        - Light Orange = Low (Zone II / Moderate Shaking, 70% radius)
        - Yellow = Very Low (Zone I / Light Perceptible Tremor, 100% radius)
        """
        from ..geospatial.spatial import create_hazard_circle_polygon
        current_radius = self.calculate_hazard_radius_km(elapsed_seconds)

        return [
            {
                "severity": "VERY_LOW",
                "name": "Zone I: Very Low (Perceptible Tremor)",
                "colorName": "Yellow",
                "fillColor": "#facc15",
                "strokeColor": "#eab308",
                "fillOpacity": 0.22,
                "lineWidth": 2.0,
                "radiusKm": round(current_radius * 1.00, 2),
                "coordinates": create_hazard_circle_polygon(origin_lng, origin_lat, round(current_radius * 1.00, 2), 36)
            },
            {
                "severity": "LOW",
                "name": "Zone II: Low (Moderate Shaking)",
                "colorName": "Light Orange",
                "fillColor": "#fb923c",
                "strokeColor": "#f97316",
                "fillOpacity": 0.28,
                "lineWidth": 2.2,
                "radiusKm": round(current_radius * 0.70, 2),
                "coordinates": create_hazard_circle_polygon(origin_lng, origin_lat, round(current_radius * 0.70, 2), 36)
            },
            {
                "severity": "MID",
                "name": "Zone III: Mid (Strong Shaking)",
                "colorName": "Dark Orange",
                "fillColor": "#ea580c",
                "strokeColor": "#c2410c",
                "fillOpacity": 0.35,
                "lineWidth": 2.5,
                "radiusKm": round(current_radius * 0.45, 2),
                "coordinates": create_hazard_circle_polygon(origin_lng, origin_lat, round(current_radius * 0.45, 2), 36)
            },
            {
                "severity": "HIGH",
                "name": "Zone IV: High (Severe Epicentral Shaking)",
                "colorName": "Red",
                "fillColor": "#ef4444",
                "strokeColor": "#b91c1c",
                "fillOpacity": 0.45,
                "lineWidth": 2.8,
                "radiusKm": round(current_radius * 0.20, 2),
                "coordinates": create_hazard_circle_polygon(origin_lng, origin_lat, round(current_radius * 0.20, 2), 36)
            }
        ]

    def evaluate_point_impact(
        self,
        lat: float,
        lng: float,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int
    ) -> Dict[str, Any]:
        epicentral_dist = haversine_distance_km(lat, lng, origin_lat, origin_lng)
        focal_depth = self.properties.get("depth", 12.0)
        hypo_dist = math.sqrt(epicentral_dist ** 2 + focal_depth ** 2)

        peak_pga = self.properties.get("pga", 0.42)
        # Standard seismic attenuation: PGA decays with hypocentral distance
        attenuation = focal_depth / hypo_dist
        local_pga = peak_pga * (attenuation ** 1.3)

        current_radius = self.calculate_hazard_radius_km(elapsed_seconds)
        in_zone = epicentral_dist <= current_radius and local_pga >= 0.08

        # Building and road damage states
        damage_state = "NONE"
        is_blocked = False

        if in_zone:
            if local_pga > 0.60:
                damage_state = "DESTROYED"
                is_blocked = True
            elif local_pga > 0.40:
                damage_state = "SEVERE"
                is_blocked = True
            elif local_pga > 0.22:
                damage_state = "MODERATE"
                is_blocked = (elapsed_seconds > 45) # Aftershocks block roads
            elif local_pga > 0.10:
                damage_state = "MINOR"

        return {
            "in_hazard_zone": in_zone,
            "intensity": round(min(1.0, local_pga / 1.0), 3),
            "local_pga": round(local_pga, 3),
            "blocked": is_blocked,
            "damage_state": damage_state
        }
