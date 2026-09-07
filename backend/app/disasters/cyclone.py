"""Dynamic moving tropical cyclone model with C-shaped recurving track and swept swath."""

from typing import Dict, Any, List
from .base import BaseDisaster
from ..geospatial.spatial import (
    haversine_distance_km,
    calculate_dynamic_cyclone_track,
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

    def calculate_category(self) -> Dict[str, str]:
        """
        Dynamically determine cyclone intensity category based on the user-manipulated
        factors: MAX SUSTAINED WINDS (km/h) and STORM SURGE HEIGHT (m).
        """
        wind = self.properties.get("windSpeed", 175)
        surge = self.properties.get("stormSurge", 3.2)

        if wind >= 220 or surge >= 5.5:
            return {"category": "CAT 5", "name": "SUPER CYCLONIC STORM", "tag": "CAT 5 · SUPER CYCLONE"}
        elif wind >= 178 or surge >= 4.0:
            return {"category": "CAT 4", "name": "EXTREMELY SEVERE CYCLONIC STORM", "tag": "CAT 4 · EXTREME"}
        elif wind >= 154 or surge >= 2.8:
            return {"category": "CAT 3", "name": "VERY SEVERE CYCLONIC STORM", "tag": "CAT 3 · VERY SEVERE"}
        elif wind >= 119 or surge >= 1.8:
            return {"category": "CAT 2", "name": "SEVERE CYCLONIC STORM", "tag": "CAT 2 · SEVERE"}
        elif wind >= 90 or surge >= 1.2:
            return {"category": "CAT 1", "name": "CYCLONIC STORM", "tag": "CAT 1 · CYCLONIC"}
        else:
            return {"category": "TROPICAL STORM", "name": "DEEP DEPRESSION", "tag": "TROPICAL STORM"}

    def calculate_hazard_radius_km(self, elapsed_seconds: int = 0) -> float:
        """
        Calculates destructive gale-force wind radius (km).
        The hazard area scales directly with the user-manipulated factors:
        MAX SUSTAINED WINDS (70 to 280 km/h) and STORM SURGE HEIGHT (0.5 to 8.0 m).
        Scales between 1.0 km (minimal) and 4.0 km (Cat 5 Super Cyclone).
        """
        wind = self.properties.get("windSpeed", 175)
        surge = self.properties.get("stormSurge", 3.2)
        nw = self._clamp((wind - 70.0) / 210.0)
        ns = self._clamp((surge - 0.5) / 7.5)
        radius = 1.0 + nw * 2.0 + ns * 1.0
        return round(radius, 2)

    def get_cyclone_track(
        self,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int,
        city_lat: float = 13.0827,
        city_lng: float = 80.2707
    ) -> List[List[float]]:
        """Returns the polyline waypoints [lng, lat] traversed dynamically up to elapsed_seconds."""
        return calculate_dynamic_cyclone_track(
            origin_lat=origin_lat,
            origin_lng=origin_lng,
            city_lat=city_lat,
            city_lng=city_lng,
            elapsed_seconds=elapsed_seconds
        )

    def get_cyclone_eye(
        self,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int,
        city_lat: float = 13.0827,
        city_lng: float = 80.2707
    ) -> List[float]:
        """Returns the current [lng, lat] coordinate of the cyclone eye."""
        track = self.get_cyclone_track(origin_lat, origin_lng, elapsed_seconds, city_lat=city_lat, city_lng=city_lng)
        return track[-1] if track else [origin_lng, origin_lat]

    def evaluate_point_impact(
        self,
        lat: float,
        lng: float,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int,
        city_lat: float = 13.0827,
        city_lng: float = 80.2707
    ) -> Dict[str, Any]:
        """
        Evaluates physical impact at (lat, lng) against the swept swath of the moving cyclone.
        Points within the gale radius of the swept path sustain impact and damage.
        """
        radius = self.calculate_hazard_radius_km(elapsed_seconds)
        track = self.get_cyclone_track(origin_lat, origin_lng, elapsed_seconds, city_lat=city_lat, city_lng=city_lng)
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
