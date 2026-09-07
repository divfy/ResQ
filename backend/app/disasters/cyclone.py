"""Dynamic moving tropical cyclone model with C-shaped recurving track and swept swath."""

from typing import Dict, Any, List
from .base import BaseDisaster
from ..geospatial.spatial import (
    haversine_distance_km,
    calculate_cyclone_track,
    min_distance_to_track_km,
    create_swept_swath_polygon
)

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
        nw, ns, nr = self._clamp((w - 70) / 210), self._clamp((s - .5) / 7.5), self._clamp((r - 15) / 125)
        return round(1 + (nw * .45 + ns * .35 + nr * .20) * 4, 2)

    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        """Radius of the destructive gale-force wind field around the cyclone eye."""
        wind, surge = self.properties["windSpeed"], self.properties["stormSurge"]
        max_radius = 5.0 + wind / 35.0 + surge * .4
        t = max(0.0, elapsed_seconds)
        if t < 15: factor = .50 + .30 * (t / 15.0)
        elif t < 60: factor = .80 + .20 * ((t - 15) / 45.0)
        elif t < 300: factor = 1.0
        else: factor = max(.45, 1.0 - (t - 300) * .0005)
        return round(max_radius * factor, 2)

    def calculate_track_progress(self, elapsed_seconds: int) -> float:
        """
        Normalized progress [0.0, 1.0] of the cyclone along its recurving track.
        Completes the C-shaped track over ~60 simulation seconds.
        """
        t = max(0.0, elapsed_seconds)
        if t <= 0:
            return 0.0
        if t < 60:
            return round(t / 60.0, 3)
        return 1.0

    def get_cyclone_track(self, origin_lat: float, origin_lng: float, elapsed_seconds: int) -> List[List[float]]:
        """Returns the polyline waypoints [lng, lat] traversed up to elapsed_seconds."""
        progress = self.calculate_track_progress(elapsed_seconds)
        return calculate_cyclone_track(origin_lat, origin_lng, progress=progress, total_steps=32)

    def get_cyclone_eye(self, origin_lat: float, origin_lng: float, elapsed_seconds: int) -> List[float]:
        """Returns the current [lng, lat] coordinate of the cyclone eye."""
        track = self.get_cyclone_track(origin_lat, origin_lng, elapsed_seconds)
        return track[-1] if track else [origin_lng, origin_lat]

    def evaluate_point_impact(self, lat, lng, origin_lat, origin_lng, elapsed_seconds) -> Dict[str, Any]:
        """
        Evaluates physical impact at (lat, lng) against the swept swath of the moving cyclone.
        Points within the gale radius of the swept path sustain impact and damage.
        """
        radius = self.calculate_hazard_radius_km(elapsed_seconds)
        track = self.get_cyclone_track(origin_lat, origin_lng, elapsed_seconds)
        dist_to_path = min_distance_to_track_km(lat, lng, track)

        if radius <= 0 or dist_to_path > radius:
            return {"in_hazard_zone": False, "intensity": 0.0, "wind_speed": 0.0, "storm_surge": 0.0, "blocked": False, "damage_state": "NONE"}

        eye_lng, eye_lat = track[-1]
        dist_to_eye = haversine_distance_km(lat, lng, eye_lat, eye_lng)

        # Proximity ratio relative to path corridor and active eye
        rel_path = self._clamp(dist_to_path / max(.1, radius))
        rel_eye = self._clamp(dist_to_eye / max(.1, radius * 1.5))

        # Active peak eyewall wind vs residual swath corridor wind
        eyewall_intensity = .65 + .35 * (1.0 - rel_eye)
        corridor_intensity = max(.35, 1.0 - rel_path * 0.7)
        intensity = max(eyewall_intensity if dist_to_eye <= radius else 0.0, corridor_intensity)

        local_wind = round(self.properties["windSpeed"] * intensity, 1)
        local_surge = round(self.properties["stormSurge"] * (1.0 - rel_path), 2)
        blocked = local_wind > 130 or local_surge > 1.2

        if local_wind > 190: state = "SEVERE"
        elif local_wind > 140: state = "MODERATE"
        elif local_wind > 90: state = "MINOR"
        else: state = "EXPOSED"

        return {
            "in_hazard_zone": True,
            "intensity": round(intensity, 3),
            "wind_speed": local_wind,
            "storm_surge": local_surge,
            "blocked": blocked,
            "damage_state": state
        }
