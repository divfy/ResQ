"""GeoJSON map vector data routes for Mapbox GL JS."""

from fastapi import APIRouter, HTTPException
from typing import Dict, Any
from ....app.schemas.schemas import GeoJSONFeatureCollection
from ....app.simulation.engine import SimulationManager
from ....app.geospatial.osm import OSMLoader

router = APIRouter(tags=["map"])

@router.get("/cities/{city_id}/map")
def get_city_map_data(city_id: str):
    """Retrieve full baseline map layers for city initialization."""
    infra = OSMLoader.get_city_infrastructure(city_id)
    center = [infra.get("longitude", 80.27), infra.get("latitude", 13.08)]
    
    # 1. 3D Buildings GeoJSON (disabled to remove synthetic greyish black boxes)
    building_features = []

    # 2. Roads GeoJSON
    road_features = []
    for r in infra.get("roads", []):
        road_features.append({
            "type": "Feature",
            "properties": {
                "id": r["id"],
                "name": r["name"],
                "blocked": False,
                "speed": r.get("speedKmh", 50)
            },
            "geometry": {
                "type": "LineString",
                "coordinates": r["coordinates"]
            }
        })

    # 3. POIs GeoJSON
    poi_features = []
    for h in infra.get("hospitals", []):
        poi_features.append({
            "type": "Feature",
            "properties": {
                "id": h["id"],
                "type": "hospital",
                "name": h["name"],
                "status": h["operationalStatus"],
                "beds": h["beds"],
                "availableBeds": h["availableBeds"],
                "icuBeds": h["icuBeds"],
                "powerStatus": h["powerStatus"]
            },
            "geometry": {
                "type": "Point",
                "coordinates": [h["longitude"], h["latitude"]]
            }
        })

    for s in infra.get("shelters", []):
        poi_features.append({
            "type": "Feature",
            "properties": {
                "id": s["id"],
                "type": "shelter",
                "name": s["name"],
                "status": s["status"],
                "capacity": s["capacity"],
                "remainingCapacity": s["remainingCapacity"]
            },
            "geometry": {
                "type": "Point",
                "coordinates": [s["longitude"], s["latitude"]]
            }
        })

    for p in infra.get("powerStations", []):
        poi_features.append({
            "type": "Feature",
            "properties": {
                "id": p["id"],
                "type": "outage",
                "name": p["name"],
                "status": p["status"],
                "capacityMW": p.get("capacityMW", 100)
            },
            "geometry": {
                "type": "Point",
                "coordinates": [p["longitude"], p["latitude"]]
            }
        })

    return {
        "city": infra["city"],
        "center": center,
        "bbox": infra.get("bbox", []),
        "buildings": {"type": "FeatureCollection", "features": building_features},
        "roads": {"type": "FeatureCollection", "features": road_features},
        "pois": {"type": "FeatureCollection", "features": poi_features}
    }

@router.get("/simulations/{sim_id}/roads")
def get_simulation_roads_geojson(sim_id: str):
    """Dynamic road layer with real-time blockage statuses."""
    sim = SimulationManager.get_simulation(sim_id)
    if not sim:
        raise HTTPException(status_code=404, detail="Simulation not found.")

    features = []
    for r in sim.current_state["roads"]:
        features.append({
            "type": "Feature",
            "properties": {
                "id": r["id"],
                "name": r["name"],
                "blocked": r["blocked"],
                "damageState": r["damageState"],
                "hazardExposure": r.get("hazardExposure", 0.0)
            },
            "geometry": {
                "type": "LineString",
                "coordinates": r["coordinates"]
            }
        })
    return {"type": "FeatureCollection", "features": features}

@router.get("/simulations/{sim_id}/hazards")
def get_simulation_hazards_geojson(sim_id: str):
    """Dynamic hazard polygon envelope."""
    sim = SimulationManager.get_simulation(sim_id)
    if not sim:
        raise HTTPException(status_code=404, detail="Simulation not found.")

    poly_coords = sim.current_state["hazardPolygon"]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "name": f"Active {sim.disaster.upper()} Envelope",
                "severity": sim.current_state["severity"],
                "radiusKm": sim.current_state["hazardRadiusKm"]
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [poly_coords]
            }
        }]
    }

@router.get("/simulations/{sim_id}/evacuation-routes")
def get_simulation_evac_routes_geojson(sim_id: str):
    """Dynamic clear evacuation routes avoiding blocked roads."""
    sim = SimulationManager.get_simulation(sim_id)
    if not sim:
        raise HTTPException(status_code=404, detail="Simulation not found.")

    features = []
    for route in sim.current_state["evacuationRoutes"]:
        features.append({
            "type": "Feature",
            "properties": {
                "id": route["id"],
                "name": route["name"],
                "fromZone": route["fromZone"],
                "toShelter": route["toShelter"],
                "status": "clear"
            },
            "geometry": {
                "type": "LineString",
                "coordinates": route["coordinates"]
            }
        })
    return {"type": "FeatureCollection", "features": features}
