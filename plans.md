# Performance
- [x] Performance has no issues (also tested with `?mock=1`)

# UI/UX

# Wanted features
- [x] Filter objects by associated launch (e.g. toggle a visual filter to see all COSMOS 2251 debris at once)
  - [x] Selecting a launch group frames its members in the camera (needs `fitEntities`, in progress with the camera work)
- [x] Better camera controls: align with the planetary surface, zoom according to altitude, fit associated objects
  - Delivered as modeled Falcon 9 ascent charts plus a telemetry ingest endpoint; no open live telemetry source exists, so measured data needs a feed (webcast OCR is still a stub)
- [x] 3D models for (some?) objects. Try implementing the ISS and making use of its special data streams for solar array angles.
  - Delivered: procedural ISS, satellite and rocket-stage models; SARJ angles and attitude verified against live data. The 8 beta gimbal (BGA) angles are unverified (observed ~43 deg vs computed ~3 deg), so arrays fall back to a computed sun-tracking pose when the BGA mapping cannot be trusted
- [x] allow users to enter optional supported api keys and credentials in the user interface, which will locally get the data instead of the eyesinorbit server
  - Delivered as a KEYS panel: values go to the local server (localhost only), which makes the requests with them; the browser never calls Space-Track itself. Needs a manual check against a real Space-Track account
- [x] Implement the Moon and Sun
  - [x] Change positional reference point between celestial bodies (includes the Sun)
  - Delivered: Moon and Sun at true size and position (low-precision almanac series in core, `Body.ephemeris` hook, ecliptic-to-equatorial fix for heliocentric orbits), EARTH / MOON / SUN tabs centre and follow the body, readouts relative to it. Orbit lines are translated rather than re-sampled in the new frame, Mars is still disabled, surface view is Earth-only, and the views were only checked in a headless browser
- [x] Higher resolution Earth texture
  - Code done: the scene prefers `earth-hires.jpg` (NASA Blue Marble 5400 x 2700) and falls back to the 2k map. Run `npm run assets` to download it and check it looks right; NASA licence terms not verified
- [ ] Booster trajectory for Falcon 9 and similar
- [ ] Trajectories for rockets other than Falcon 9
  - what other sources are there for launch trajectories?
- [ ] trajectory data OCR using the existing livestream embedding?

# Feature issues
- [x] Surface mode does not vertically fit an object, only tracks its surface position. When toggled without a focused object, locks to a specific point on Earth and cannot pan
  - Fixed, needs a manual look in the browser: the surface view now aims halfway up to the object and frames the whole ground-to-object segment (also on FIT of one object), and right/shift drag slides the ground target (a followed object is let go; with nothing focused the view roams)
- [x] Events timeline in Falcon 9 launch viewer stacks overlapping events so that the first event's text overlaps with the next event's line; change the stacking so that the first event is highest and subsequent ones are below it
  - Fixed (`labelY` in `lib/ascent-chart.ts`, unit-tested); needs a visual check on a real launch