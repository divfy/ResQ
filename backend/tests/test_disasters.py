"""Unit tests for disaster physics models and city compatibility."""

import pytest
from backend.app.disasters import create_disaster_model
from backend.app.disasters.flood import FloodDisaster
from backend.app.disasters.earthquake import EarthquakeDisaster
from backend.app.disasters.cyclone import CycloneDisaster
from backend.app.disasters.tsunami import TsunamiDisaster
from backend.app.geospatial.osm import OSMLoader
from backend.app.simulation.engine import SimulationManager

def test_city_compatibility():
    """Verify city disaster compatibility constraints."""
    delhi_infra = OSMLoader.get_city_infrastructure("delhi")
    assert "flood" in delhi_infra["supportedDisasters"]
    assert "earthquake" in delhi_infra["supportedDisasters"]
    assert "cyclone" not in delhi_infra["supportedDisasters"]
    assert "tsunami" not in delhi_infra["supportedDisasters"]

    chennai_infra = OSMLoader.get_city_infrastructure("chennai")
    assert "flood" in chennai_infra["supportedDisasters"]
    assert "earthquake" in chennai_infra["supportedDisasters"]
    assert "cyclone" in chennai_infra["supportedDisasters"]
    assert "tsunami" in chennai_infra["supportedDisasters"]

def test_flood_simulation_model():
    """Verify flood severity calculation and impact evaluation."""
    flood = FloodDisaster({"waterDepth": 2.5, "velocity": 2.0, "duration": 24})
    sev = flood.calculate_severity()
    assert 1.0 <= sev <= 5.0

    origin_lat, origin_lng = 13.0827, 80.2707
    impact_close = flood.evaluate_point_impact(13.0830, 80.2710, origin_lat, origin_lng, elapsed_seconds=120)
    assert impact_close["in_hazard_zone"] is True
    assert impact_close["water_depth"] > 0.0

    impact_far = flood.evaluate_point_impact(14.5, 82.0, origin_lat, origin_lng, elapsed_seconds=120)
    assert impact_far["in_hazard_zone"] is False
    assert impact_far["blocked"] is False

def test_earthquake_simulation_model():
    """Verify earthquake seismic attenuation and damage states."""
    quake = EarthquakeDisaster({"pga": 0.85, "duration": 45, "depth": 10})
    sev = quake.calculate_severity()
    assert sev >= 3.0

    origin_lat, origin_lng = 28.6139, 77.2090
    impact_epicenter = quake.evaluate_point_impact(28.6140, 77.2091, origin_lat, origin_lng, elapsed_seconds=30)
    assert impact_epicenter["in_hazard_zone"] is True
    assert impact_epicenter["damage_state"] in ("SEVERE", "DESTROYED")
    assert impact_epicenter["blocked"] is True

def test_cyclone_simulation_model():
    """Verify cyclone aerodynamic progression and storm surge."""
    cyclone = CycloneDisaster({"windSpeed": 210, "stormSurge": 4.5, "rainfall": 90})
    sev = cyclone.calculate_severity()
    assert 1.0 <= sev <= 5.0
    assert sev >= 3.0

    origin_lat, origin_lng = 13.0827, 80.2707
    impact = cyclone.evaluate_point_impact(13.0850, 80.2720, origin_lat, origin_lng, elapsed_seconds=120)
    assert impact["in_hazard_zone"] is True
    assert impact["wind_speed"] > 100.0

def test_cyclone_swath_and_tracking():
    """Verify cyclone dynamic city steering, open-ended movement, category, and radius scaling."""
    # Test physical scaling from wind and surge
    cyclone_min = CycloneDisaster({"windSpeed": 70, "stormSurge": 0.5})
    assert cyclone_min.calculate_hazard_radius_km(0) == 1.0
    assert cyclone_min.calculate_category()["category"] == "TROPICAL STORM"

    cyclone_max = CycloneDisaster({"windSpeed": 280, "stormSurge": 8.0})
    assert cyclone_max.calculate_hazard_radius_km(0) == 4.0
    assert cyclone_max.calculate_category()["category"] == "CAT 5"

    cyclone = CycloneDisaster({"windSpeed": 190, "stormSurge": 3.8, "rainfall": 70})
    cat = cyclone.calculate_category()
    assert cat["category"] == "CAT 4"
    assert "EXTREME" in cat["tag"]

    origin_lat, origin_lng = 13.05, 80.40

    eye_0 = cyclone.get_cyclone_eye(origin_lat, origin_lng, elapsed_seconds=0)
    assert abs(eye_0[0] - 80.40) < 0.001
    assert abs(eye_0[1] - 13.05) < 0.001

    eye_40 = cyclone.get_cyclone_eye(origin_lat, origin_lng, elapsed_seconds=40)
    # Eye steers inland towards central Chennai (< 80.30 lng)
    assert eye_40[0] < 80.32

    eye_80 = cyclone.get_cyclone_eye(origin_lat, origin_lng, elapsed_seconds=80)
    # Does not stop: eye continues advancing and curves northward
    assert eye_80[1] > eye_40[1]

    # Beyond 60 seconds: open-ended movement continues
    eye_120 = cyclone.get_cyclone_eye(origin_lat, origin_lng, elapsed_seconds=120)
    assert eye_120 != eye_80

    # Verify that a point hit in the middle of the path remains in the swept hazard zone
    impact_midway = cyclone.evaluate_point_impact(eye_40[1], eye_40[0], origin_lat, origin_lng, elapsed_seconds=80)
    assert impact_midway["in_hazard_zone"] is True

def test_tsunami_simulation_model():
    """Verify tsunami wave run-up and coastal scouring."""
    tsunami = TsunamiDisaster({"waveHeight": 12.0, "inundationDist": 3.5, "waveVelocity": 60})
    sev = tsunami.calculate_severity()
    assert 1.0 <= sev <= 5.0
    assert sev >= 2.5

    origin_lat, origin_lng = 13.0827, 80.2707
    impact_coast = tsunami.evaluate_point_impact(13.0830, 80.2710, origin_lat, origin_lng, elapsed_seconds=60)
    assert impact_coast["in_hazard_zone"] is True
    assert impact_coast["blocked"] is True
