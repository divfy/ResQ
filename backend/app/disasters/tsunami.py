"""First-order tsunami arrival and inland inundation model."""

from typing import Dict, Any
from .base import BaseDisaster
from ..geospatial.spatial import haversine_distance_km

DEFAULT_TSUNAMI_PROPS = [
    {"id": "waveHeight", "name": "WAVE RUN-UP HEIGHT", "unit": "m", "min": 1, "max": 25, "step": .5, "defaultValue": 7.5},
    {"id": "inundationDist", "name": "INUNDATION DISTANCE", "unit": "km", "min": .2, "max": 8, "step": .1, "defaultValue": 2.8},
    {"id": "waveVelocity", "name": "WAVE VELOCITY", "unit": "km/h", "min": 20, "max": 120, "step": 2, "defaultValue": 55},
]


class TsunamiDisaster(BaseDisaster):
    def __init__(self, properties: Dict[str, float] | None):
        super().__init__("tsunami", properties, DEFAULT_TSUNAMI_PROPS)

    def calculate_severity(self) -> float:
        h, d, v = self.properties["waveHeight"], self.properties["inundationDist"], self.properties["waveVelocity"]
        nh, nd, nv = self._clamp((h-1)/24), self._clamp((d-.2)/7.8), self._clamp((v-20)/100)
        return round(1 + (nh*.45 + nd*.35 + nv*.20)*4, 2)

    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        inundation = self.properties["inundationDist"]
        t = max(0.0, elapsed_seconds)
        if t < 6: return 0.0
        if t < 18: return round(0.5 + inundation * ((t - 6) / 12.0), 2)
        if t < 300: return round(inundation + 0.5, 2)
        return round((inundation + 0.5) * max(0.4, 1.0 - (t - 300) / 1200.0), 2)

    def calculate_surge_progress(self, elapsed_seconds: int) -> float:
        """
        Calculates oceanic surge front progression:
        - t=0: Wave formation offshore in the bay (progress ~ 0.20)
        - t=6s: Rapid oceanic wave travel, making landfall on Chennai coast (progress ~ 0.80)
        - t=18s: Inland inundation reaches user's pinpoint (progress = 1.0)
        - t=18-300s: Peak inundation sustained
        - t>300s: Gradual recession
        """
        t = max(0.0, elapsed_seconds)
        if t <= 0:
            return 0.20
        if t < 6:
            return round(0.20 + (t / 6.0) * 0.60, 3)
        if t < 18:
            return round(0.80 + ((t - 6.0) / 12.0) * 0.20, 3)
        if t < 300:
            return 1.0
        return round(max(0.35, 1.0 - (t - 300) / 1200.0), 3)

    def evaluate_point_impact(self, lat, lng, origin_lat, origin_lng, elapsed_seconds) -> Dict[str, Any]:
        """
        Directional oceanic tsunami inundation model for Chennai:
        Surge originates offshore in the Bay of Bengal (east / right) and flows
        westward across the coastline toward the user-selected pinpoint.
        """
        lat_span = 0.24
        lat_diff = abs(lat - origin_lat)
        if lat_diff > lat_span:
            return {"in_hazard_zone": False, "intensity": 0.0, "surge_height": 0.0, "blocked": False, "damage_state": "NONE"}

        progress = self.calculate_surge_progress(elapsed_seconds)
        ocean_lng = max(80.40, origin_lng + 0.10)

        # Calculate where the surge front has reached at this latitude
        y = (lat - origin_lat) / lat_span
        inland_factor = max(0.12, (1.0 - 0.38 * (y ** 2)))
        front_lng = ocean_lng - (ocean_lng - origin_lng) * progress * inland_factor

        # If point is further west than the wave front has reached, it is not inundated yet
        if lng < front_lng:
            return {"in_hazard_zone": False, "intensity": 0.0, "surge_height": 0.0, "blocked": False, "damage_state": "NONE"}

        # Point is submerged under the advancing ocean surge
        depth_ratio = min(1.0, max(0.15, (lng - front_lng) / max(0.01, ocean_lng - origin_lng) + 0.35))
        local_height = round(self.properties["waveHeight"] * depth_ratio, 2)
        blocked = local_height > 0.8

        if local_height > 5.0: state = "DESTROYED"
        elif local_height > 2.5: state = "SEVERE"
        elif local_height > 1.0: state = "MODERATE"
        elif local_height > 0.4: state = "MINOR"
        else: state = "EXPOSED"

        return {
            "in_hazard_zone": True,
            "intensity": round(depth_ratio, 3),
            "surge_height": local_height,
            "blocked": blocked,
            "damage_state": state
        }
