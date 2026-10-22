# Performance
- [x] Performance has no issues (also tested with `?mock=1`)

# UI/UX
- [x] Round unnecessary decimals so changing values stop adding and removing newlines in their text boxes
- [x] Drag borders to resize the UI

# Wanted features
- [x] Filter objects by associated launch (e.g. toggle a visual filter to see all COSMOS 2251 debris at once)
  - [x] Selecting a launch group frames its members in the camera (needs `fitEntities`, in progress with the camera work)
  - [ ] Verify the CelesTrak debris groups against live data (blocked: CelesTrak returns HTTP 403 for repeated downloads)
- [x] Better camera controls: align with the planetary surface, zoom according to altitude, fit associated objects
- [ ] Realistic distance projection
- [ ] Unrender objects outside of reasonable view or scope of the current focus object
- [ ] try implementing data stream visualization for the upcoming starlink group 15-15 launch (or 15-16 if too late)
- [ ] 3D models for (some?) objects. Try implementing the ISS and making use of its special data streams for solar array angles.
- [ ] Livestreams can be popped out and dragged around within the interface

# Feature issues
- [x] Earth does not block the background stars behind it
- [x] Demo booster and deep space objects do not have a trajectory
- [ ] Trajectories and objects seem to oscillate at high zoom; found while watching the demo booster landing
- [ ] Flickering of the 3D viewport when resized (not urgent)
- [ ] Icons on the surface of the earth clip into it when the earth is rotated
- [ ] Youtube embedded streams do not hide their youtube overlay which obstructs streams