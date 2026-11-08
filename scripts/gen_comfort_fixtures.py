"""Reference values for MRT / PMV / PPD from pythermalcomfort (independent implementation).

Usage:
    uv run --with pythermalcomfort==3.* python -I scripts/gen_comfort_fixtures.py > tests/fixtures/comfort-vectors.json
"""
import importlib.metadata
import json
import math
import sys

from pythermalcomfort.models import pmv_ppd_iso

cases = []
grid = [
    # ta, tr, vr, rh, met, clo
    (22.0, 22.0, 0.10, 60, 1.2, 0.5),
    (27.0, 27.0, 0.10, 60, 1.2, 0.5),
    (27.0, 27.0, 0.30, 60, 1.2, 0.5),
    (23.5, 25.5, 0.10, 60, 1.2, 0.5),
    (23.5, 25.5, 0.30, 60, 1.2, 0.5),
    (19.0, 19.0, 0.10, 40, 1.2, 1.0),
    (23.5, 23.5, 0.10, 40, 1.2, 1.0),
    (23.5, 23.5, 0.30, 40, 1.2, 1.0),
    (23.0, 21.0, 0.10, 40, 1.2, 1.0),
    (23.0, 21.0, 0.30, 40, 1.2, 1.0),
    (22.0, 22.0, 0.10, 60, 1.6, 0.5),
    (27.0, 27.0, 0.10, 60, 1.6, 0.5),
    (27.0, 27.0, 0.30, 60, 1.6, 0.5),
    # typical office / M-Logger readings
    (24.2, 25.1, 0.12, 48, 1.1, 1.0),
    (26.5, 28.0, 0.05, 55, 1.1, 0.5),
    (20.0, 19.2, 0.20, 35, 1.0, 1.2),
    (28.0, 29.5, 0.40, 65, 1.2, 0.6),
    (18.0, 17.0, 0.08, 30, 1.4, 1.5),
]
for ta, tr, vr, rh, met, clo in grid:
    r = pmv_ppd_iso(tdb=ta, tr=tr, vr=vr, rh=rh, met=met, clo=clo, limit_inputs=False, round_output=False)
    pmv = float(r.pmv) if hasattr(r, "pmv") else float(r["pmv"])
    ppd = float(r.ppd) if hasattr(r, "ppd") else float(r["ppd"])
    cases.append({"ta": ta, "tr": tr, "vr": vr, "rh": rh, "met": met, "clo": clo, "pmv": pmv, "ppd": ppd})


# MRT (ISO 7726 Annex B, larger of natural/forced convection), computed here in plain Python
# with the official app's constants for an independent check of the TypeScript port.
def mrt(ta, tg, v, d=0.038, eps=0.95):
    hc1 = 1.4 * (abs(tg - ta) / d) ** 0.25
    hc2 = 6.3 * v**0.6 / d**0.4
    return max(0.0, (tg + 273.15) ** 4 + max(hc1, hc2) / (eps * 5.67e-8) * (tg - ta)) ** 0.25 - 273.15


mrt_cases = [
    {"ta": ta, "tg": tg, "v": v, "mrt": mrt(ta, tg, v)}
    for ta, tg, v in [(24.0, 25.0, 0.1), (24.0, 26.5, 0.05), (22.0, 21.0, 0.3), (26.0, 26.0, 0.2), (20.0, 24.0, 0.0), (25.0, 27.0, 1.2)]
]

json.dump(
    {"pythermalcomfort": importlib.metadata.version("pythermalcomfort"), "pmv": cases, "mrt": mrt_cases},
    sys.stdout,
    indent=2,
)
print()
