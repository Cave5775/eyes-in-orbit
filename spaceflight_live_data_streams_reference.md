# Viable Spaceflight Data Streams for Mission Control Applications

This document provides a technical directory of accessible, non-paid data streams, APIs, and telemetry reconstruction methods for building a real-time spaceflight tracking and mission control application.

---

## 1. Launch Manifests & Mission Metadata

These feeds supply mission countdown clocks ($T-$ time), vehicle specifications, launch pad coordinates, target orbital inclinations, and verified webcast stream URLs.

### Launch Library 2 (TheSpaceDevs)
* **Description:** The gold standard for global rocket launch manifests, rocket hardware configurations, astronaut rosters, and launch pad coordinates.
* **Endpoint:** `https://ll.thespacedevs.com/2.2.0/launch/upcoming/`
* **Protocol / Format:** REST / JSON
* **Auth / Rate Limit:** Free tier (~15 requests per hour without key, higher limits with free registered token).
* **Payload Highlights:**
  * `net`: Scheduled launch time (ISO 8601 UTC).
  * `pad`: Latitude, longitude, elevation, and name of launch complex.
  * `vidURLs`: Official live stream links (YouTube, X, NASA TV).
  * `mission.orbit`: Target orbit (e.g., LEO, GTO, SSO, Moon).
  * `status`: Real-time status flags (Go for Launch, Hold, In Flight, Success, Failure).

### Spaceflight News API (SNAPI)
* **Description:** Aggregates real-time news articles and launch reports across aerospace journalism outlets.
* **Endpoint:** `https://api.spaceflightnewsapi.net/v4/articles/`
* **Protocol / Format:** REST / JSON
* **Auth / Rate Limit:** Open / Public (no authentication required).
* **Usage:** Supplies mission news tickers and operational updates during launch holds or anomalies.

---

## 2. Active Launch Ascent Trajectories & Telemetry

Commercial and government launch providers do not provide open programmatic telemetry streams during powered ascent due to ITAR and export-control restrictions. The following methods allow developers to track or reconstruct active ascents.

### Community Webcast OCR Pipeline
* **Description:** Video frame capture and Optical Character Recognition (OCR) targeting on-screen vehicle Heads-Up Displays (SpaceX, Rocket Lab, Firefly, ISRO).
* **Source:** Official YouTube Webcasts / HLS video streams.
* **Data Extracted:**
  * Mission elapsed time ($T+$, in seconds).
  * Instantaneous velocity ($v(t)$, in $\text{km/h}$ or $\text{m/s}$).
  * Instantaneous altitude ($h(t)$, in $\text{km}$).
  * Stage separation and engine cut-off events (MECO, SECO).
* **Kinematic Trajectory Reconstruction:**
  Given pad coordinates $(\phi_0, \lambda_0)$ and launch azimuth $\theta_{\text{az}}$, the downrange displacement $\Delta s$ across time step $\Delta t$ is computed via:
  $$\Delta s = \sqrt{\max\left(0, v(t)^2 - \left(\frac{dh}{dt}\right)^2\right)} \cdot \Delta t$$
* **Latency:** $2\text{–}5\text{ seconds}$ relative to live broadcast.

### Flight Club API (Declan Murphy / Flight Club Aero)
* **Description:** High-fidelity community-modeled physics trajectories of historical and upcoming launches based on payload mass, vehicle stage thrust, and public hazard corridors.
* **Endpoint:** `https://flightclub.io/` (simulation export endpoints)
* **Protocol / Format:** REST / JSON or CSV export
* **Payload Highlights:**
  * High-resolution timeline ($0.1\text{s}$ intervals) of altitude, velocity, downrange distance, throttle level, dynamic pressure ($Q$), and vehicle pitch/yaw angles.
* **Usage:** Ideal for rendering nominal trajectory flight paths in CesiumJS synchronized with countdown timers.

### FAA NOTAMs & Maritime Navigational Warnings
* **Description:** Official regulatory exclusion zones defining launch pad azimuths, stage drop zones (boosters, fairings), and re-entry corridors.
* **Sources:**
  * FAA Air Traffic Control System Command Center (ATCSCC) Space Operations.
  * National Geospatial-Intelligence Agency (NGA) NAVAREA navigational warnings.
* **Data Format:** Coordinates delineating geographic polygons.
* **Usage:** Provides visual exclusion envelopes on the 3D globe to outline the vehicle's ground track before flight.

---

## 3. On-Orbit Telemetry & Ephemeris Feeds

These streams provide positional tracking and vehicle telemetry for spacecraft already inserted into Earth orbit.

### NASA ISSLive (International Space Station)
* **Description:** NASA's public real-time operations feed broadcasting live telemetry frames directly from the ISS vehicle bus.
* **Endpoint:** `push.lightstreamer.com` (Adapter: `ISSLIVE`)
* **Protocol / Format:** Lightstreamer (WebSocket / Comet push protocol)
* **Auth / Rate Limit:** Free / Open public push
* **Key Available Telemetry Points:**
  * `USLAB000032`: State vector geodetic position (Latitude, Longitude, Altitude).
  * `USLAB000033`: Orbital velocity vector ($\text{m/s}$).
  * `S0000001`–`S0000004`: Solar array rotary joint angles (SARJ) and beta gimbal angles (BGA).
  * Vehicle attitude rates (Roll, Pitch, Yaw).
  * Station life support parameters (internal cabin pressure, $O_2 / CO_2$ levels).

### CelesTrak TLE & Orbit Data
* **Description:** Highly reliable, continuously refreshed Two-Line Element (TLE) sets and General Perturbations (GP) orbital data.
* **Endpoints:**
  * Active Space Stations: `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle`
  * Active Satellites: `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle`
  * Starlink Constellation: `https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle`
* **Protocol / Format:** HTTP GET / TLE text format or OMM (JSON/XML)
* **Auth / Rate Limit:** Completely free, no registration required. Recommended cache TTL: $2\text{–}6\text{ hours}$.
* **Usage:** Fed directly into local SGP4 propagators (`satellite.js`) to generate smooth, continuous 3D orbital tracks and ground swaths.

### Space-Track.org (18th Space Defense Squadron)
* **Description:** Official source of the U.S. Space Force satellite catalog (SATCAT), decay predictions, and definitive orbital elements.
* **Endpoint:** `https://www.space-track.org/basicspacedata/query/...`
* **Protocol / Format:** REST / JSON
* **Auth / Rate Limit:** Free user account required. Up to 30 requests per minute.
* **Usage:** Resolving international designators, catalog numbers, launch dates, apogee/perigee, and tracking newly cataloged orbital debris.

### "Where The ISS At?" API
* **Description:** Lightweight, pre-propagated endpoint for real-time ISS tracking.
* **Endpoint:** `https://api.wheretheiss.at/v1/satellites/25544`
* **Protocol / Format:** REST / JSON
* **Auth / Rate Limit:** Free (up to 1 request per second without authentication).
* **Payload Highlights:**
  * `latitude`, `longitude`, `altitude` (km), `velocity` (km/h), `visibility` (daylight/eclipsed), `footprint` (ground visibility radius).

---

## 4. Deep Space & Ground Station Feeds

Streams covering spacecraft beyond Earth orbit and real-time antenna tracking.

### NASA DSN Now (Deep Space Network)
* **Description:** Live operational status of the three giant deep-space communications complexes (Goldstone, Madrid, and Canberra) communicating with missions such as Voyager 1 & 2, JWST, Perseverance, and Artemis.
* **Endpoint:** `https://eyes.nasa.gov/dsn/api/dsn.xml` (or JSON equivalent)
* **Protocol / Format:** HTTP Polling / XML or JSON
* **Auth / Rate Limit:** Public, recommended polling interval: $5\text{ seconds}$.
* **Payload Highlights:**
  * Active antenna identifiers (e.g., DSS-14, DSS-43).
  * Target spacecraft identifier (e.g., `VGR1`, `JWST`, `M20`).
  * Uplink and downlink frequency, radiated power ($\text{kW}$), and active data rate ($\text{kbps}$).
  * Signal round-trip light time (RTLT, in seconds) and physical range from Earth ($\text{km}$).

### SatNOGS Network (Amateur Satellite Ground Network)
* **Description:** Global crowdsourced network of Software Defined Radio (SDR) ground stations capturing and decoding satellite downlinks.
* **Endpoints:**
  * Network Observations: `https://network.satnogs.org/api/observations/`
  * Telemetry Database: `https://db.satnogs.org/api/telemetry/`
* **Protocol / Format:** REST / JSON
* **Auth / Rate Limit:** Free API token required for write access; open read access.
* **Usage:** Provides actual raw downlinked demodulated telemetry packets from university CubeSats, weather satellites, and secondary mission payloads.

---

## 5. Technical Comparison Matrix

| Data Feed | Phase / Target | Protocol | Update Frequency | Real-Time Latency | Implementation Complexity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Launch Library 2** | Pre-Launch / Counts | REST | $15\text{–}60\text{ min}$ | Nominal | Low (Standard REST polling) |
| **Webcast OCR** | Active Ascent | Video Stream | $1\text{–}5\text{ Hz}$ | $2\text{–}5\text{ seconds}$ | High (Computer vision + Kinematics) |
| **Flight Club Models** | Ascent Simulation | REST / Static | Per Mission | Synchronous ($T-0$) | Low to Medium |
| **NASA ISSLive** | ISS On-Orbit | Lightstreamer | $1\text{ Hz}$ Push | Sub-second | Medium (WebSocket client setup) |
| **CelesTrak (TLE)** | Multi-Satellite Orbit | HTTP / SGP4 | $2\text{–}4\times\text{ daily}$ | Sub-millisecond (computed) | Low (Client-side math) |
| **Where The ISS At?** | ISS Orbit | REST | Up to $1\text{ Hz}$ | $1\text{ second}$ | Very Low |
| **NASA DSN Now** | Deep Space | XML / Polling | Every $5\text{ seconds}$ | $5\text{ seconds}$ | Low |
| **SatNOGS DB** | CubeSats / SmallSats | REST | Overpass-driven | Minutes to hours | Medium to High |

---


### Architectural Recommendations
1. **Never query orbital feeds at 60 Hz:** Download TLEs once every few hours and run the SGP4 propagation locally in a Web Worker at 60 FPS using `satellite.js`.
2. **Handle Launch Windows Gracefully:** Maintain an internal mission state machine (`SCHEDULED` $\rightarrow$ `COUNTDOWN` $\rightarrow$ `ACTIVE_ASCENT` $\rightarrow$ `ORBIT_INSERTION` $\rightarrow$ `ON_ORBIT`) driven by Launch Library 2 status codes.
3. **Decouple Video and Telemetry:** Keep live stream panels embedded via iframe so UI rerenders and orbital calculations never stutter the live video feed.