"""Unit tests for NetworkX road graph and dynamic evacuation routing."""

import pytest
from backend.app.geospatial.routing import RoadNetwork
from backend.app.evacuation.engine import EvacuationEngine

def test_road_network_routing():
    """Verify route finding across unblocked roads."""
    sample_roads = [
        {
            "id": "rd-1",
            "name": "Arterial A",
            "speedKmh": 60,
            "blocked": False,
            "coordinates": [[80.20, 13.00], [80.22, 13.02], [80.24, 13.04]]
        },
        {
            "id": "rd-2",
            "name": "Arterial B",
            "speedKmh": 50,
            "blocked": False,
            "coordinates": [[80.24, 13.04], [80.26, 13.06], [80.28, 13.08]]
        }
    ]

    net = RoadNetwork(sample_roads)
    route = net.get_evacuation_route(80.20, 13.00, 80.28, 13.08)
    assert route is not None
    assert len(route) >= 3

def test_road_blockage_prevents_traversal():
    """Verify that blocked roads are not traversed by routing."""
    sample_roads = [
        {
            "id": "rd-direct",
            "name": "Direct Road (Blocked)",
            "speedKmh": 60,
            "blocked": True,
            "coordinates": [[80.20, 13.00], [80.28, 13.08]]
        }
    ]

    net = RoadNetwork(sample_roads)
    route = net.get_evacuation_route(80.20, 13.00, 80.28, 13.08)
    # Cannot traverse single blocked road
    assert route is None

def test_alternate_route_recalculation():
    """Verify routing selects clear alternate path when primary is blocked."""
    sample_roads = [
        {
            "id": "rd-primary",
            "name": "Primary (Blocked)",
            "speedKmh": 60,
            "blocked": True,
            "coordinates": [[80.20, 13.00], [80.24, 13.04], [80.28, 13.08]]
        },
        {
            "id": "rd-bypass-1",
            "name": "Bypass Leg 1",
            "speedKmh": 50,
            "blocked": False,
            "coordinates": [[80.20, 13.00], [80.22, 13.08]]
        },
        {
            "id": "rd-bypass-2",
            "name": "Bypass Leg 2",
            "speedKmh": 50,
            "blocked": False,
            "coordinates": [[80.22, 13.08], [80.28, 13.08]]
        }
    ]

    net = RoadNetwork(sample_roads)
    route = net.get_evacuation_route(80.20, 13.00, 80.28, 13.08)
    assert route is not None
    # Verify the route used the bypass coordinates
    has_bypass_midpoint = any(abs(pt[0] - 80.22) < 0.001 and abs(pt[1] - 13.08) < 0.001 for pt in route)
    assert has_bypass_midpoint is True

def test_evacuation_engine_hazard_aware_routing():
    """Verify that only threatened zones evacuate, safe shelters outside are chosen, and fake lines are not synthesized."""
    origin_lat, origin_lng = 13.0800, 80.2700
    hazard_radius_km = 2.5

    # Road from threatened zone (80.271, 13.081) to safe shelter (80.320, 13.120)
    sample_roads = [
        {
            "id": "rd-evac-open",
            "name": "Evacuation Route Highway",
            "speedKmh": 50,
            "blocked": False,
            "coordinates": [
                [80.271, 13.081],
                [80.290, 13.100],
                [80.320, 13.120]
            ]
        }
    ]

    population_zones = [
        {
            "id": "zone-threatened",
            "name": "Epicenter District",
            "center": [80.271, 13.081], # ~0.15 km from epicenter (THREATENED)
            "population": 15000
        },
        {
            "id": "zone-safe",
            "name": "Faraway Safe Suburb",
            "center": [80.120, 12.950], # ~20 km away (SAFE - should NOT evacuate)
            "population": 25000
        }
    ]

    shelters = [
        {
            "id": "shl-danger",
            "name": "Flooded Community Hall",
            "latitude": 13.0820,
            "longitude": 80.2720, # Inside hazard zone (~0.3 km) - DANGEROUS, MUST REJECT
            "status": "OPERATIONAL",
            "remainingCapacity": 400
        },
        {
            "id": "shl-safe",
            "name": "Safe High-Ground Stadium",
            "latitude": 13.1200,
            "longitude": 80.3200, # Outside hazard zone (~6.5 km) - SAFE DESTINATION
            "status": "OPERATIONAL",
            "remainingCapacity": 1200
        }
    ]

    net = RoadNetwork(sample_roads)
    engine = EvacuationEngine(net, population_zones, shelters)

    routes = engine.compute_evacuation_routes(
        shelters,
        origin_lat=origin_lat,
        origin_lng=origin_lng,
        hazard_radius_km=hazard_radius_km
    )

    # 1. Exactly 1 evacuation corridor for the threatened zone
    assert len(routes) == 1
    assert routes[0]["fromZone"] == "Epicenter District"
    # 2. Destination is the SAFE shelter outside the hazard zone, NOT the flooded one
    assert routes[0]["toShelter"] == "Safe High-Ground Stadium"
    # 3. Route follows actual road geometry (3 points)
    assert len(routes[0]["coordinates"]) >= 3
    # 4. Faraway safe district did not generate a route
    assert not any(r["fromZone"] == "Faraway Safe Suburb" for r in routes)

    # 5. When connecting road is blocked, NO fake 3-point straight line is synthesized
    engine.update_network_from_road_status([{"id": "rd-evac-open", "blocked": True}])
    severed_routes = engine.compute_evacuation_routes(
        shelters,
        origin_lat=origin_lat,
        origin_lng=origin_lng,
        hazard_radius_km=hazard_radius_km
    )
    assert len(severed_routes) == 0

