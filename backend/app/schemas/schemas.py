"""Pydantic schemas for RESQ REST API and WebSocket events."""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# --- GeoJSON Schemas ---

class GeoJSONGeometry(BaseModel):
    type: str
    coordinates: Any


class GeoJSONFeature(BaseModel):
    type: str = "Feature"
    properties: Dict[str, Any] = Field(default_factory=dict)
    geometry: GeoJSONGeometry


class GeoJSONFeatureCollection(BaseModel):
    type: str = "FeatureCollection"
    features: List[GeoJSONFeature] = Field(default_factory=list)


# --- City & Scenario Schemas ---

class OriginCoordinate(BaseModel):
    latitude: float
    longitude: float


class CityInfo(BaseModel):
    id: str
    name: str
    country: str
    countryCode: str
    type: str  # "landlocked" | "coastal"
    latitude: float
    longitude: float
    population: int
    supportedDisasters: List[str]
    bbox: List[float]


class ScenarioCreate(BaseModel):
    city: str
    disaster: str
    origin: Optional[OriginCoordinate] = None
    properties: Optional[Dict[str, float]] = None
    seed: Optional[int] = 42


class ScenarioResponse(BaseModel):
    id: str
    city: str
    disaster: str
    origin: OriginCoordinate
    properties: Dict[str, float]
    severity: float
    seed: int
    createdAt: str


# --- Telemetry & State Schemas ---

class HospitalStatus(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    beds: int
    availableBeds: int
    icuBeds: int
    availableIcu: int
    powerStatus: str
    operationalStatus: str  # OPERATIONAL, STRESSED, NEAR_CAPACITY, FULL, COMPROMISED, OFFLINE
    occupancyPct: float


class ShelterStatus(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    capacity: int
    occupancy: int
    remainingCapacity: int
    status: str  # OPERATIONAL, FULL, INACCESSIBLE
    occupancyPct: float


class RoadStatus(BaseModel):
    id: str
    name: str
    blocked: bool
    damageState: str  # NONE, MINOR, MODERATE, SEVERE, DESTROYED
    hazardExposure: float
    coordinates: List[List[float]]


class PowerStatus(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    status: str  # OPERATIONAL, FLOODED, OVERLOADED, OFFLINE
    capacityMW: float


class AIResponse(BaseModel):
    summary: str
    guidance: str
    threats: List[str] = Field(default_factory=list)
    priorities: List[str] = Field(default_factory=list)
    timestamp: str


class OverviewMetrics(BaseModel):
    affectedPopulation: int
    casualties: int = 0
    availableHospitals: int
    fullHospitals: int
    totalHospitals: int
    blockedRoads: int
    activeShelters: int
    totalShelters: int
    powerOutages: int
    hospitalCapacityPct: Optional[float] = 0.0
    totalBeds: Optional[int] = 0
    availableBeds: Optional[int] = 0


class SimulationStateResponse(BaseModel):
    simulationId: str
    scenarioId: str
    city: str
    disaster: str
    status: str  # INITIALIZED, RUNNING, PAUSED, STOPPED, COMPLETED
    elapsedSeconds: int
    speed: int
    severity: float
    origin: OriginCoordinate
    properties: Dict[str, float]
    metrics: OverviewMetrics
    aiResponse: AIResponse


# --- Control Schemas ---

class SpeedChange(BaseModel):
    speed: int = Field(ge=1, le=5)


class PropertyUpdate(BaseModel):
    properties: Dict[str, float]


class OriginUpdate(BaseModel):
    latitude: float
    longitude: float


# --- Standard Error Schema ---

class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class StandardErrorResponse(BaseModel):
    error: ErrorDetail
