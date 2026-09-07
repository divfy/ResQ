"""First-order pluvial/inundation flood model."""

import math
from typing import Dict, Any
from .base import BaseDisaster
from ..geospatial.spatial import haversine_distance_km

DEFAULT_FLOOD_PROPS = [
    {"id": "waterDepth", "name": "WATER DEPTH", "unit": "m", "min": 0.2, "max": 6.0, "step": 0.1, "defaultValue": 1.8},
    {"id": "velocity", "name": "FLOW VELOCITY", "unit": "m/s", "min": 0.1, "max": 4.5, "step": 0.1, "defaultValue": 1.4},
    {"id": "duration", "name": "INUNDATION DURATION", "unit": "hrs", "min": 2, "max": 72, "step": 1, "defaultValue": 18},
]


class FloodDisaster(BaseDisaster):
    def __init__(self, properties: Dict[str, float] | None):
        super().__init__("flood", properties, DEFAULT_FLOOD_PROPS)

    def calculate_severity(self) -> float:
        depth, velocity, duration = self.properties["waterDepth"], self.properties["velocity"], self.properties["duration"]
        nd = self._clamp((depth - .2) / 5.8)
        nv = self._clamp((velocity - .1) / 4.4)
        nt = self._clamp((duration - 2) / 70)
        return round(1.0 + (nd*.45 + nv*.35 + nt*.20)*4.0, 2)

    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        depth, velocity = self.properties["waterDepth"], self.properties["velocity"]
        max_radius = 2.5 + depth*.8 + velocity*.4
        t = max(0.0, elapsed_seconds)
        # Smooth rise toward peak inundation, then slow recession.
        growth = 1.0 - math.exp(-t / 150.0)
        if t > 600:
            growth *= max(0.4, 1.0 - (t - 600.0) / 2400.0)
        return round(max_radius * growth, 2)

    def evaluate_point_impact(self, lat, lng, origin_lat, origin_lng, elapsed_seconds) -> Dict[str, Any]:
        radius = self.calculate_hazard_radius_km(elapsed_seconds)
        dist = haversine_distance_km(lat, lng, origin_lat, origin_lng)
        if radius <= 0 or dist > radius:
            return {"in_hazard_zone": False, "intensity": 0.0, "water_depth": 0.0, "blocked": False, "damage_state": "NONE"}

        proximity = self._clamp(1.0 - dist / max(.1, radius))
        # Depth is a first-order radial proxy; it is not a DEM-based inundation calculation.
        local_depth = self.properties["waterDepth"] * proximity
        blocked = local_depth > .45 or (local_depth > .25 and self.properties["velocity"] > 1.5)
        if local_depth > 2.5: state = "SEVERE"
        elif local_depth > 1.2: state = "MODERATE"
        elif local_depth > .45: state = "MINOR"
        else: state = "EXPOSED"
        return {"in_hazard_zone": True, "intensity": round(proximity,3), "water_depth": round(local_depth,2), "blocked": blocked, "damage_state": state}
