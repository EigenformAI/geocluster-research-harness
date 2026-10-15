# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj==3.7.2"]
# ///
"""Fixed synthetic training outline. No network grids or external map assets."""
import json
import sys

import pyproj
from pyproj import Transformer, network

network.set_network_enabled(False)
# Explicit inverse transverse Mercator followed by GDA2020 geographic coordinates.
# RFC 7946 positions use the documented GDA2020/WGS84 identity approximation.
pipeline = "+proj=pipeline +step +inv +proj=utm +zone=51 +south +ellps=GRS80"
transform = Transformer.from_pipeline(pipeline)
ring = [[round(lon, 8), round(lat, 8)] for lon, lat in
        (transform.transform(east, north) for east, north in json.load(sys.stdin))]
print(json.dumps({"ring": ring, "transformation": {
    "tool": "pyproj", "version": pyproj.__version__, "projVersion": pyproj.proj_version_str,
    "pipeline": pipeline, "input": "EPSG:7851", "geographic": "EPSG:7844",
    "output": "OGC:CRS84", "axisOrder": "longitude,latitude", "precisionDecimalPlaces": 8,
    "datumOperation": "GDA2020 geographic treated as WGS84 for synthetic map context; no epoch transformation",
    "accuracyMetres": 3, "networkGrids": False
}}, separators=(",", ":")))
