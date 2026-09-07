"""Base interfaces and shared helpers for disaster models."""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseDisaster(ABC):
    def __init__(self, name: str, properties: Dict[str, float] | None, default_properties: list[Dict[str, Any]]):
        self.name = name.lower()
        self.default_properties = default_properties
        supplied = properties or {}
        self.properties: Dict[str, float] = {}
        for prop in default_properties:
            pid = prop["id"]
            value = supplied.get(pid, prop["defaultValue"])
            # UI/API callers must not be able to push the model outside its declared range.
            value = max(prop["min"], min(prop["max"], float(value)))
            self.properties[pid] = value

    @abstractmethod
    def calculate_severity(self) -> float:
        """Return a normalized severity index from 1.0 to 5.0."""
        raise NotImplementedError

    @abstractmethod
    def calculate_hazard_radius_km(self, elapsed_seconds: int) -> float:
        """Return the current first-order hazard envelope radius in kilometres."""
        raise NotImplementedError

    @abstractmethod
    def evaluate_point_impact(
        self,
        lat: float,
        lng: float,
        origin_lat: float,
        origin_lng: float,
        elapsed_seconds: int,
    ) -> Dict[str, Any]:
        """Evaluate hazard intensity and infrastructure-relevant effects at a point."""
        raise NotImplementedError

    def get_progress_phase(self, elapsed_seconds: int) -> str:
        if elapsed_seconds <= 0:
            return "INITIAL"
        if elapsed_seconds < 60:
            return "ONSET"
        if elapsed_seconds < 300:
            return "PEAK_INTENSIFICATION"
        if elapsed_seconds < 600:
            return "STABILIZATION"
        return "RECOVERY"

    @staticmethod
    def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
        return max(low, min(high, value))
