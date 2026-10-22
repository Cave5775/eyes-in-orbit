# Performance
- [x] Performance has no issues (also tested with `?mock=1`)

# UI/UX
- [x] Round unnecessary decimals so changing values stop adding and removing newlines in their text boxes
- [x] Drag borders to resize the UI

# Wanted features
- [x] Filter objects by associated launch (e.g. toggle a visual filter to see all COSMOS 2251 debris at once)
  - [ ] Selecting a launch group frames its members in the camera (needs `fitEntities`, in progress with the camera work)
  - [ ] Verify the CelesTrak debris groups against live data (blocked: CelesTrak returns HTTP 403 for repeated downloads)
- [ ] Better camera controls: align with the planetary surface, zoom according to altitude, fit associated objects
- [ ] Realistic distance projection
- [ ] Unrender objects outside of reasonable view or scope of the current focus object

# Feature issues
- [ ] Earth does not block the background stars behind it
- [ ] Demo booster and deep space objects do not have a trajectory
