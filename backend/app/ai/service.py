"""AI Decision Support and Situation Synthesis Service."""

import os
import json
import httpx
from typing import Dict, Any, List
from datetime import datetime
from ..core.config import settings
from ..core.logging import logger

class AIService:
    @classmethod
    async def generate_situation_briefing(
        cls,
        city: str,
        disaster: str,
        severity: float,
        elapsed_seconds: int,
        metrics: Dict[str, Any],
        hospitals: List[Dict[str, Any]],
        shelters: List[Dict[str, Any]],
        roads: List[Dict[str, Any]],
        power: List[Dict[str, Any]],
        events: List[Dict[str, Any]],
        properties: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Generate grounded situation briefing and evacuation directives.
        Calls Google Gemini API if GEMINI_API_KEY / AI_API_KEY is configured,
        otherwise produces deterministic, telemetry-grounded rule synthesis.
        """
        api_key = settings.GEMINI_API_KEY
        if api_key and len(api_key) > 5:
            try:
                ai_result = await cls._call_gemini_api(
                    api_key, city, disaster, severity, elapsed_seconds,
                    metrics, hospitals, shelters, roads, power, events, properties
                )
                if ai_result:
                    return ai_result
            except Exception as e:
                logger.warning(f"Gemini API invocation failed ({e}); falling back to local synthesis engine.")

        # Fallback to local rule-based synthesis engine
        return cls._generate_rule_based_synthesis(
            city, disaster, severity, elapsed_seconds,
            metrics, hospitals, shelters, roads, power, events, properties
        )

    @classmethod
    async def _call_gemini_api(
        cls,
        api_key: str,
        city: str,
        disaster: str,
        severity: float,
        elapsed_seconds: int,
        metrics: Dict[str, Any],
        hospitals: List[Dict[str, Any]],
        shelters: List[Dict[str, Any]],
        roads: List[Dict[str, Any]],
        power: List[Dict[str, Any]],
        events: List[Dict[str, Any]],
        properties: Dict[str, float]
    ) -> Dict[str, Any]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
        
        prompt = f"""You are the RESQ Autonomous Emergency Operations AI.
Synthesize an emergency command sitrep based SOLELY on the real telemetry provided below.
DO NOT invent or extrapolate numbers not present in the data.

Telemetry:
City: {city}
Disaster: {disaster.upper()}
Severity Index: {severity} / 5.0
Elapsed Sim Time: {elapsed_seconds} seconds ({elapsed_seconds // 60}m)
Affected Population: {metrics.get('affectedPopulation', 0):,}
Blocked Roads: {metrics.get('blockedRoads', 0)}
Available Hospitals: {metrics.get('availableHospitals', 0)} / {metrics.get('totalHospitals', 0)}
Active Shelters: {metrics.get('activeShelters', 0)} / {metrics.get('totalShelters', 0)}
Power Outages: {metrics.get('powerOutages', 0)}
Recent Events: {[e.get('message') for e in events[-4:]]}
Disaster Properties: {properties}

Return JSON with exact keys:
{{
  "summary": "1-2 concise tactical sentences summarizing the situation.",
  "guidance": "1-2 actionable operational directives for civilian evacuation and emergency triage.",
  "threats": ["threat 1", "threat 2"],
  "priorities": ["priority 1", "priority 2"]
}}
"""
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.2
            }
        }
        
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                parsed = json.loads(text)
                parsed["timestamp"] = datetime.now().strftime("%H:%M:%S")
                return parsed
        return None

    @classmethod
    def _generate_rule_based_synthesis(
        cls,
        city: str,
        disaster: str,
        severity: float,
        elapsed_seconds: int,
        metrics: Dict[str, Any],
        hospitals: List[Dict[str, Any]],
        shelters: List[Dict[str, Any]],
        roads: List[Dict[str, Any]],
        power: List[Dict[str, Any]],
        events: List[Dict[str, Any]],
        properties: Dict[str, float]
    ) -> Dict[str, Any]:
        elapsed_min = elapsed_seconds // 60
        affected_pop = metrics.get("affectedPopulation", 0)
        blocked_rds = metrics.get("blockedRoads", 0)
        avail_hosp = metrics.get("availableHospitals", 0)
        total_hosp = metrics.get("totalHospitals", 0)
        full_hosp = metrics.get("fullHospitals", 0)
        active_shl = metrics.get("activeShelters", 0)
        outages = metrics.get("powerOutages", 0)

        sev_label = "CRITICAL CATASTROPHIC" if severity >= 4.0 else "SEVERE ELEVATED" if severity >= 3.0 else "MODERATE MONITORING"

        # Format properties
        prop_str = ", ".join([f"{k}: {v}" for k, v in list(properties.items())[:3]])

        # Disaster-specific vocabulary
        if disaster == "flood":
            mech = "low-lying inundation and storm drainage overflow"
            evac_dir = "Direct citizens from flood basins toward elevated eastern quadrants and reinforced concrete relief hubs."
            threats = ["Basement flood traps", "Submerged electrical substations", "Arterial road bed erosion"]
            priorities = ["Deploy high-clearance rescue vehicles", "Isolate submerged power transformers", "Supply clean water to shelters"]
        elif disaster == "earthquake":
            mech = "catastrophic structural shear, foundation displacement, and masonry fractures"
            evac_dir = "Establish open-air staging corridors away from high-rise perimeters; route casualties to surviving field clinics."
            threats = ["Structural collapse during aftershocks", "Damaged overpass spans", "Trauma capacity saturation"]
            priorities = ["Clear transit arteries for ambulances", "Conduct bridge structural inspections", "Erect emergency triage tents"]
        elif disaster == "cyclone":
            mech = "violent aerodynamic uplift, high-speed projectile debris, and storm surge"
            evac_dir = "Hold civilians inside interior reinforced rooms; halt all high-profile transit until gale winds subside."
            threats = ["Overturned high-profile vehicles", "Downed live powerlines", "Coastal storm surge intrusion"]
            priorities = ["De-energize severed power feeders", "Clear arterial highways of fallen trees", "Secure coastal port cranes"]
        else:  # tsunami
            mech = "extreme hydrodynamic scouring, scouring foundation erosion, and violent coastal wave penetration"
            evac_dir = "Execute immediate vertical and high-ground inland evacuation beyond 4km shoreline contour; abandon low-lying transit."
            threats = ["Violent receding currents", "Floating debris battering rams", "Coastal highway washouts"]
            priorities = ["Evacuate port and beach perimeters", "Safeguard inland relief corridors", "Mobilize maritime search and rescue"]

        casualties = metrics.get("casualties", 0)
        cas_str = f" ({casualties:,} casualties requiring triage)" if casualties > 0 else ""

        summary = (
            f"T+{elapsed_min}m SITREP — {city.upper()} [{sev_label} — SEV {severity:.1f}/5.0]: "
            f"An active {disaster.upper()} scenario is escalating across metropolitan districts ({prop_str}). "
            f"Impact is characterized by {mech}. Currently, {affected_pop:,} civilians are within the direct hazard envelope"
            f"{cas_str}, with {blocked_rds} arterial road corridors blocked and {outages} electrical grid substations offline."
        )

        guidance = (
            f"OPERATIONAL DIRECTIVE: {evac_dir} "
            f"{avail_hosp} of {total_hosp} primary trauma centers remain operational; "
            f"divert inbound ambulances away from {full_hosp} saturated facilities. "
            f"{active_shl} high-capacity designated shelters are currently receiving evacuees along designated green corridors."
        )

        return {
            "summary": summary,
            "guidance": guidance,
            "threats": threats,
            "priorities": priorities,
            "timestamp": datetime.now().strftime("%H:%M:%S")
        }
