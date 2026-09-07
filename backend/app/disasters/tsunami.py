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
        # Travel time is represented explicitly; before arrival there is no inundation.
        inundation = self.properties["inundationDist"]
        t = max(0.0, elapsed_seconds)
        if t < 30: return 0.0
        if t < 180: return round(.2 + inundation*((t-30)/150.0), 2)
        if t < 600: return round(inundation + .2, 2)
        return round((inundation + .2) * max(.4, 1 - (t-600)/2400.0), 2)

    def evaluate_point_impact(self, lat, lng, origin_lat, origin_lng, elapsed_seconds) -> Dict[str, Any]:
        reach = self.calculate_hazard_radius_km(elapsed_seconds)
        dist = haversine_distance_km(lat, lng, origin_lat, origin_lng)
        if reach <= 0 or dist > reach:
            return {"in_hazard_zone": False, "intensity": 0.0, "surge_height": 0.0, "blocked": False, "damage_state": "NONE"}
        proximity = self._clamp(1 - dist/max(.2, reach))
        local_height = self.properties["waveHeight"] * proximity
        blocked = local_height > .8
        if local_height > 5: state = "DESTROYED"
        elif local_height > 2.5: state = "SEVERE"
        elif local_height > 1: state = "MODERATE"
        elif local_height > .4: state = "MINOR"
        else: state = "EXPOSED"
        return {"in_hazard_zone": True, "intensity": round(proximity,3), "surge_height": round(local_height,2), "blocked": blocked, "damage_state": state}
