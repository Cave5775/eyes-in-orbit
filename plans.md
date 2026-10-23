# Performance
- [x] Performance has no issues (also tested with `?mock=1`)

# UI/UX

# Wanted features
- [x] Filter objects by associated launch (e.g. toggle a visual filter to see all COSMOS 2251 debris at once)
  - [x] Selecting a launch group frames its members in the camera (needs `fitEntities`, in progress with the camera work)
  - [ ] Verify the CelesTrak debris groups against live data (blocked: CelesTrak returns HTTP 403 for repeated downloads)
- [x] Better camera controls: align with the planetary surface, zoom according to altitude, fit associated objects
  - Delivered as modeled Falcon 9 ascent charts plus a telemetry ingest endpoint; no open live telemetry source exists, so measured data needs a feed (webcast OCR is still a stub)
- [x] 3D models for (some?) objects. Try implementing the ISS and making use of its special data streams for solar array angles.
  - Delivered: procedural ISS, satellite and rocket-stage models; SARJ angles and attitude verified against live data. The 8 beta gimbal (BGA) angles are unverified (observed ~43 deg vs computed ~3 deg), so arrays fall back to a computed sun-tracking pose when the BGA mapping cannot be trusted
- [ ] Implement the Moon and Sun

# Feature issues
- [ ] Surface view pan does not work