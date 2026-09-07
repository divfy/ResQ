"""First-order tropical cyclone wind/surge model."""

from typing import Dict, Any
from .base import BaseDisaster
from ..geospatial.spatial import haversine_distance_km

DEFAULT_CYCLONE_PROPS = [
    {"id": "windSpeed", "name": "MAX SUSTAINED WINDS", "unit": "km/h", "min": 70, "max": 280, "step": 5, "defaultValue": 175},
    {"id": "stormSurge", "name": "STORM SURGE HEIGHT", "unit": "m", "min": .5, "max": 8, "step": .2, "defaultValue": 3.2},
    {"id": "rainfall", "name": "RAINFALL INTENSITY", "unit": "mm/h", "min": 15, "max": 140, "step": 5, "defaultValue": 65},
]


class CycloneDisaster(BaseDisaster):
    def __init__(self, properties: Dict[str, float] | None):
        super().__init__("cyclone", properties, DEFAULT_CYCLONE_PROPS)

    def calculate_severity(self) -> float:
        w, s, r = self.properties["windSpeed"], self.properties["stormSurge"], self.properties["rainfall"]
        nw, ns, nr = self._clamp((w-70)/210), self._clamp((s-.5)/7.5), self._clamp((r-15)/125)
        return round(1 + (nw*.45 + ns*.35 + nr*.20)*4, 2)

    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        wind, surge = self.properties["windSpeed"], self.properties["stormSurge"]
        max_radius = 5.0 + wind/30.0 + surge*.5
        t = max(0.0, elapsed_seconds)
        if t < 90: factor = .25 + .55*(t/90.0)
        elif t < 240: factor = .80 + .20*((t-90)/150.0)
        else: factor = max(.45, 1.0 - (t-240)*.0008)
        return round(max_radius * factor, 2)

    def evaluate_point_impact(self, lat, lng, origin_lat, origin_lng, elapsed_seconds) -> Dict[str, Any]:
        radius = self.calculate_hazard_radius_km(elapsed_seconds)
        dist = haversine_distance_km(lat, lng, origin_lat, origin_lng)
        if radius <= 0 or dist > radius:
            return {"in_hazard_zone": False, "intensity": 0.0, "wind_speed": 0.0, "storm_surge": 0.0, "blocked": False, "damage_state": "NONE"}
        rel = self._clamp(dist / max(.1, radius))
        # Simple radial wind profile: strongest near the modeled core/eyewall.
        intensity = .65 + .35*(rel/.20) if rel < .20 else max(.1, 1 - (rel-.20)/.80)
        local_wind = self.properties["windSpeed"] * intensity
        local_surge = self.properties["stormSurge"] * (1-rel)
        blocked = local_wind > 130 or local_surge > 1.2
        if local_wind > 190: state = "SEVERE"
        elif local_wind > 140: state = "MODERATE"
        elif local_wind > 90: state = "MINOR"
        else: state = "EXPOSED"
        return {"in_hazard_zone": True, "intensity": round(intensity,3), "wind_speed": round(local_wind,1), "storm_surge": round(local_surge,2), "blocked": blocked, "damage_state": state}
