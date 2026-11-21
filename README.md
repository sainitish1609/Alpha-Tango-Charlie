# VECTOR — voice ATC with live crews

You work the frequency by voice. Every aircraft has a real crew: someone specific on the radio, with their own accent, mood and way of talking, who reads back what they understood, asks you things on quiet moments, and sounds like a person on a VHF radio rather than a computer.

- **Claude** writes what each pilot says, in character, and understands you when you don't use textbook phraseology ("FedEx 741, you're good to go to Washington, up to five grand, squawk 4612"). It runs on your own Claude Code login, or an API key.
- **Free local voices** speak it: [Piper](https://github.com/rhasspy/piper), open source, running on your PC. One 77 MB model holds 109 real recorded speakers with their own accents: English, Scottish, Welsh, Irish, Northern Irish, American, Canadian, South African, Indian, Australian, New Zealand. Crews are cast by airline (Speedbird gets a British voice, Air Canada a Canadian one), and no two aircraft on frequency share a voice. ElevenLabs is an optional paid upgrade.
- **The radio** is simulated too: band-limited and compressed audio, each aircraft's own mic, engine noise behind airborne pilots, the APU at the gate, more hiss the farther out they are, a master caution behind a mayday.

The flight simulation stays in charge. The AI never moves an aircraft. Claude's words are checked against what the sim decided; if a reply drops or invents a number, the crew says the game's own correct readback instead.

## Start

1. Install [Node.js](https://nodejs.org) 20.12 or newer, and [Claude Code](https://claude.com/claude-code) logged in (run `claude` once in a terminal).
2. Double-click **`play.bat`**. The game opens at **http://localhost:8787** after a few seconds. Keep the black server window open while you play; closing it stops the game.
3. Use Chrome or Edge for voice input.

The first run installs and creates `.env`. Nothing needs to go in it for the default setup.

## Play on the GX10

The game also runs on the GX10 (`gx177`, 192.168.1.177), which does the heavy work: the game server, the pilot AI and the voices.

- Double-click **`play-gx10.bat`** on this PC. It opens an encrypted SSH tunnel and the game at **http://localhost:8800**. Through the tunnel the browser treats the game as local, so the microphone works. Keep the window open while you play.
- On the GX10 the server runs as a user service and starts by itself, even after a reboot: `systemctl --user status vector-atc` shows it, and `journalctl --user -u vector-atc` shows its log.
- After changing the game on this PC, `bash tools/deploy-gx10.sh` copies it over and restarts it.
- `play.bat` still runs everything on this PC, as before.
- **From any device on the home network:** open **https://192.168.1.177:8443**. It's HTTPS because browsers only allow the microphone on secure pages. To avoid the certificate warning, install the home certificate once on each device: download https://192.168.1.177:8443/ca.crt and add it to the device's trusted root certificates (on Windows: open the file → Install Certificate → Current User → "Trusted Root Certification Authorities"). The certificates live on the GX10 in `~/Work/vector-atc/certs` (made by `tools/make-certs.sh`); the private keys never leave it.
- On the GX10 itself, the **VECTOR ATC** icon (desktop and app menu, `play.sh`) opens the game at http://localhost:8787.

## Windows app and speech recognition

- **Windows app:** `desktop/` builds `VECTOR-ATC-Setup-<version>.exe` (Electron): the same web game in its own window, connected to atc.moatsoftwares.com (or the home server, via its hidden Alt menu). Build with `cd desktop && npm run dist`, then copy the installer to `~/Work/vector-atc/downloads/` on the GX10. Players get it at **/download** on the site, behind the password.
- **Updates:** from 1.7.0 the app updates itself. Copy `dist/latest.yml` to the downloads folder along with the installer and its `.blockmap`; installed apps check `/download/update/` on start and every four hours (with their sign-in cookie), download in the background and offer to restart. Help → Check for updates… checks on demand.
- **Code signing:** `npm run dist` signs when a certificate is available: `CSC_LINK` + `CSC_KEY_PASSWORD` for a .pfx (OV/EV) certificate, or `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER` with `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` for Azure Trusted Signing. Without either it builds unsigned and SmartScreen warns on first run.
- **Speech recognition in the app:** Whisper large-v3-turbo on the GX10's GPU (whisper.cpp built with CUDA in `~/Work/asr`, user service `whisper-asr` on 127.0.0.1:8178). The game sends the callsigns on frequency and the airport's runways, taxiways and fixes as a hint. About 120 ms per call. The browser version keeps the browser's own recognition (it can opt in with `localStorage.vector_asr = 'server'`).
- **Phones:** the web app opens full screen menus, one big map view, and a panel that folds away when you tap the open tab.

## Claude Code or API key

| | Claude Code (your login, default) | API key |
|---|---|---|
| Setup | nothing, if `claude` works in a terminal | `ANTHROPIC_API_KEY` in `.env` |
| Cost | counts toward your Claude plan's usage limits | about $0.05 per busy hour |
| Reply time | about 2–2.5 s | about 1 s |

With Claude Code the server keeps two `claude` processes open in the background (starting one per call would take 5–6 seconds) and swaps each for a fresh one after 12 requests. If a crew's words aren't ready in time, the pilot reads back in the game's own words so you're never kept waiting.

This uses your personal Claude login for your own play on your own PC. Don't host the game for other people on your login; give a shared copy an API key instead.

## Voices

| | Local (default) | ElevenLabs |
|---|---|---|
| Cost | free | paid plan (~30–60k characters per busy hour) |
| Sound | real recorded speakers, a little synthetic up close; on the radio it sits well | the most human: breaths, emotion |
| Speed on a small PC (Intel N100) | ~0.5 s per transmission | ~0.3 s plus network |
| Setup | none: the model downloads once (77 MB) into `models/` | `ELEVENLABS_API_KEY` in `.env` |

Setting `ELEVENLABS_API_KEY` switches to ElevenLabs; `VOICE_ENGINE=local` forces the free voices even with a key.

## Airports

Pick one in **Open shift**:

| Airport | Size | Runways | Gates | Feel |
|---|---|---|---|---|
| Pine Ridge Regional (KPRR) | Small | one, 09/27 | 6 | mountain valley, regional jets and turboprops |
| Lakeshore International (KLSI) | Medium | two parallels | 12 | the classic; Career missions are here |
| Coral Cay International (MCCY) | Medium | one long, 09/27 | 10 | tropical island, holiday jets |
| Bayport International (KBPT) | Large | two long parallels | 20 | big hub with two concourses, lots of wide-bodies |

**Runways:** at the two-runway airports, choose departures north and arrivals south, the other way round, or close one runway and run everything on the other. On a single runway, departures and arrivals take turns: launch a departure before the next arrival is inside about 5 NM, or after it has vacated. **Direction:** west (27s), east (09s), or set by the wind.

Taxiways run one way, like a real airport (toward the departure end on one side, back on the other), so ground traffic never meets head-on. Runways are always east–west (09/27).

Airports are described in `AIRPORTS` near the top of `public/index.html`; a new one is a few lines of data.

### Real map

Each airport sits on a real one, drawn from [OpenStreetMap](https://www.openstreetmap.org): Pine Ridge on Innsbruck, Lakeshore on Vancouver, Coral Cay on St. Maarten, Bayport on London Heathrow. The map is turned and scaled so the real runways lie under the game's. The **Map** button on the scope turns it on or off. The airport view shows the map by day; the radar shows a dark version.

Map tiles come through the game server and are saved in `cache/tiles`, so each one is downloaded from OpenStreetMap only once (a few MB in all). The first look at an airport needs internet; after that it works offline. Map data © OpenStreetMap contributors.

## Play

- **Open shift** in the menu: no score, no levels, just the shift. Turn points back on in the setup if you want them. **Career** still has its missions and stars.
- Talk normally. Textbook phraseology is read instantly. Anything else ("how much fuel have you got?", "you're number two, follow the 737") goes to the crew's AI, which works out who you meant and what you said.
- Pilots still mishear sometimes. Listen to every readback and correct it.
- Leave the frequency quiet and crews fill it: ride reports, "how many ahead of us?", "field in sight".

## Situations

The non-routine side of the job, modelled on the FAA controllers' manual (JO 7110.65) and ICAO Doc 4444 (PANS-ATM). Each one has its own pilot calls, a coach line with the right phraseology and the rule behind it, and points for handling it well. They are on by default (**Situations** in the setup); **Practise** picks a single one to drill.

| Kind | Situations | What the controller does |
|---|---|---|
| Emergencies | mayday or pan-pan inbound (engine failure, medical, fuel, smoke, hydraulics, bird strike, pressurisation); departure emergency and return; rejected takeoff; aircraft disabled on the runway; minimum fuel that turns into a fuel emergency if delayed; a PAN with a hold to run the checklist | “roger mayday”, priority vectors, “say souls on board and fuel remaining”, “emergency services are standing by”, “do you require assistance?”, “hold at … as published” |
| Radio and codes | radio failure, squawk 7600 (some still hear you: “if you hear me, ident”); code 7500 (often set by mistake) | keep traffic clear, steady green light from the tower; “verify squawking 7500”, then no more questions |
| Runway | runway incursion on short final; debris (FOD) and a runway inspection; wind shear go-around; birds, laser, drone reports | send the arrival around, keep the closed runway closed, pass every report to the aircraft behind (“caution, …”) |
| Airspace | TCAS resolution advisory; VFR pop-up traffic (1200); thunderstorms with deviation requests; fog with low visibility procedures; visual approach, direct and higher requests | no instructions during an RA; traffic advisories by the clock; “deviation left approved, report clear of weather”; bigger spacing and a protected ILS in fog |
| Ground | breakdown on a taxiway; return to stand; similar callsigns on frequency | route traffic round it and send a tug; taxi them back; “caution, similar callsign” |

**Holding.** Say a published hold (“hold at BOOTH as published, maintain 7000, expect further clearance 1450”) or the full form (“hold northeast of BOOTH on the 045 radial, 10 mile legs, left turns, maintain 8000, expect further clearance 1450”); “inbound track 225” and “2 minute legs” work too. Aircraft fly a real racetrack (1-minute legs, standard-rate turns, holding speed limits), drawn on the radar with the stack beside the fix. When the runway is blocked, or (on Approach) the sequence is full, the coach parks arrivals on top of the stack 1,000 ft apart, gives each an EFC 3 minutes after the one below, steps the stack down, updates EFCs that run out, and takes the lowest out first (“leave BOOTH, turn left heading …”). A crew past its EFC asks for an update; a crew with no radio leaves the hold at its EFC on its own.

**Coaching beyond the first call.** A runway incursion gets “go around, traffic on the runway” for the arrival and “hold position” for the aircraft on the runway; a mayday is followed by “say souls on board and fuel remaining” and the emergency services, and the handoff tells the crew Tower knows; a go-around gets its missed approach instructions; pilot reports (wind shear, laser, birds, drone) are added to the calls of every aircraft behind, Approach included; similar callsigns get “caution, similar callsign on frequency”, and the wrong pilot answering gets “negative, that was for …”; low visibility adds “report runway vacated”, “low visibility procedures in force” and the CAT III holding point.

Career has four missions built on them: Lost and found, Storm season, Runway trouble, Ramp rat. The logic lives in `public/situations.js`.

## Real traffic

In the setup, **Traffic** can be Simulated, **Real (ADS-B)** or VATSIM live. Real (ADS-B) takes the aircraft around the airport you picked right now from the OpenSky Network (through the server, refreshed every minute and shared by all players): real airline flights parked at the field become your departures, and real flights inbound below about 14,000 ft become your arrivals, entering when they'd reach your airspace, from where they really are. Their callsigns are real; the aircraft type and the other end of the route are filled in from the airline's fleet and routes, since ADS-B doesn't carry them. Set `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` in `.env` for more than ~400 requests a day.

## Ground operations

- **Runway crossings:** when a taxi route saves real distance by crossing the other runway in use (Heathrow's T4 departures cross 27L), the clearance includes "hold short runway 27L"; the aircraft stops there and asks, and you say "cross runway 27L" once nobody is on it, departing from it or on short final (clearing it across an occupied runway is a runway conflict).
- **Stop bars:** red lights across every holding point of the runways in use; they go dark with green lead-on lights for the aircraft you clear to line up or cross.
- **De-icing:** in snow or freezing weather departures ask for de-icing at the stand before pushback ("de-icing approved, report ready for push back"); trucks work the wings for a few minutes. The fluid protects them only for the holdover time (10 to 25 minutes, less in heavier snow): keep them waiting at the runway too long and they have to go back.
- **Follow-me:** now and then a crew new to the airport (more often at night or in low visibility) stops after its taxi clearance and asks for progressive taxi; "follow the follow me" sends the car to lead them.

## Radar tools

- **Range and bearing line:** right-drag (or Alt-drag) on the radar. Ends dropped on aircraft stick to them; the label shows the magnetic bearing, the distance and the time to go at that aircraft's speed. A click clears it, as does Esc.
- **Conflict probe:** pairs that will come within 3 NM and 1000 ft in the next two minutes, if nothing changes, get dashed amber lines to where they'd meet and the time until then.
- **Data blocks:** altitude with trend and ground speed; wake category (J for the A380, H heavy, M, L) after the callsign and with the type; **HO** flashes while a handoff is waiting, **WK** when an aircraft on final is closer behind a heavier one than wake turbulence allows (A380 → medium 7 NM, heavy → medium 5 NM…), **LA** for a low altitude alert.
- **Fog:** with visibility under 3 km the tower view shows aircraft beyond the visibility only as ground radar targets.
- **Datalink:** for a departure clearance (PDC) or the frequency change to the centre (CPDLC), the coach offers *Send by PDC/CPDLC*: the clearance goes as text and the crew answers WILCO on screen, with no radio call.

## Shift realism

- **The AI approach controller** sequences arrivals 10 NM apart (13 on a shared runway) and never turns one in beyond 34 NM, where the localizer can't be captured: the ones behind stay on their arrival, slowed to 210 kt, and orbit at its end until there's room. Holding stacks fill from the top (nobody jumps a stack) and the stack bottom that has waited longest leaves first.
- **Runway change mid-shift:** with live weather the METAR is read again every few minutes. When the wind swings round so the runway in use has more than 5 kt of tailwind (10 kt on a preferred runway like Salzburg 15), the change is announced with a new ATIS letter about 8 minutes ahead, and made once nobody is rolling, lined up or on short final: arrivals come off the old approach for vectors to the new final, and departures taxi to the new runway.
- **Graphics quality** (Settings → Display): High, Balanced (fewer pixels on high-resolution screens) or Low (normal resolution, 30 frames a second, no night lighting, glow or weather particles) for older or integrated graphics.

## Views, accessibility and sound

- **Settings → View:** presets (Tower, **Ground radar** — a flat, dark surface movement radar like ASDE-X, Approach radar, **Final monitor** — the final approach course zoomed in, Split), and every layer on its own switch: map, range rings and compass, fixes, procedure waypoints, terrain, final approach course, trails, heading lines, data blocks (full, compact or off), conflict probe, weather; in the airport view the map, vehicles and ground crews, stop bars, the selected route, aircraft labels (the ones that matter, all, none), rain/snow/fog and the wind box. Keys **4** (real look / ground radar) and **5** (final monitor); the Windows app's View menu has them all.
- **Settings → Accessibility:** text and controls size (100/115/130%), high contrast, colour-blind safe colours (arrivals blue, losses of separation magenta), a calmer screen (no sweep, no blinking). The frequency log is a live region for screen readers.
- **Airfield sound:** wind, rain, taxiing engines and takeoff roars made live from the weather and the traffic, loud in the airport view and faint behind the radar, with its own volume in Settings → Audio.

## Ratings, leaderboard, replay

- **Ratings:** position endorsements at each airport — Clearance, then Ground, Tower and Approach — each earned on a checkride with an examiner's goals. Airports go from quiet to busy (Juliana, Jersey, Madeira, Chambéry, Salzburg, Vancouver, Heathrow); a position at the next airport needs it at the one before.
- **Leaderboard:** set a name and your best score in each mission and checkride is posted to the server (`data/leaderboard.json`, kept across deploys).
- **Replay and debrief:** every shift is recorded. At the end, *Replay and debrief* plays it back on a radar at 1–32×, marks each moment that cost points on the timeline, and lists them with what to do next time; click one to watch it happen.

## Airports

Seven real airports from OpenStreetMap (`tools/build-airports.mjs`): Vancouver, London Heathrow, Salzburg, Princess Juliana, plus **Madeira** (the runway on pillars over the sea, mountains behind), **Jersey** (a short cliff-top runway, island turboprops) and **Chambéry** (ski charters in snow at the end of Lac du Bourget). The picker in the setup searches by name, code or country and filters by region and size. Each has its own ICAO phraseology, units and frequencies, magnetic variation, entry and exit fixes, airlines, and the surrounding peaks for terrain alerts. Approach spacing on a single runway adapts to how long landings really take to vacate.

## 3D tower, multiplayer, offline

- **3D tower view** (View → 3D tower, or key **6**): the airport from the tower cab in 3D, built from the same OpenStreetMap data — runways with their markings, taxiways, aprons, buildings at their heights — with every aircraft at its real size, position, heading and height, in the light, sky and fog of the moment. Drag to look round, the wheel zooms like binoculars, it follows the selected aircraft (double-click to follow again). three.js is bundled in `public/vendor` (MIT).
- **Multiplayer** (menu → Multiplayer): one player hosts — their game runs the airport — and gets a four-letter code; others join and take free positions (Clearance, Ground, Tower, Approach); the AI keeps the rest. Everyone sees the same traffic and log; each player's calls go to the host's game, and pilots answer on that player's frequency. The server relays (`/api/mp/…`, a live event stream); nothing is stored.
- **Offline (Windows app):** Server → Offline (this computer), or start the app with `--offline`. The game's files travel inside the app; it serves them itself, with no account or internet. Pilots speak with the Windows voices, the weather is simulated and you type or click your calls (speech recognition needs the game server). With Graphics quality on Low it suits older PCs.

## Runway control

The **RWY** button in the top bar opens the runway panel:

- Each runway: use it for **departures**, **arrivals** or **both**; **close** it for 5, 10 or 20 minutes or until you reopen it; **reopen** it.
- Closing a runway in use moves its traffic to the other runway: arrivals come off the old approach for vectors to the new final, departures are re-routed to the new holding point, with a new ATIS letter. When it reopens (and nobody is on short final) the usual setup comes back.
- With one runway (Salzburg, Juliana, Madeira, Jersey, Chambéry), arrivals go into the hold while it's closed, departures wait, and **Divert arrivals** sends the airborne ones to their alternates.
- **Auto** (on by default): a runway blocked by an aircraft that has stopped on it for 45 seconds closes by itself and traffic moves to the other runway; it reopens 20 seconds after it's clear. Closures from situations (debris, inspections) move traffic the same way.
- **Turn the runways around** lands and departs the other way.

## Procedures, terrain and phraseology

- **Headings are magnetic**, as pilots fly them: each airport has its magnetic variation, and every heading said, shown or read back is magnetic (the radar's compass rose too).
- **Phraseology by region:** Vancouver uses North American wording; Heathrow, Salzburg and Juliana use ICAO wording ("descend altitude 4000 feet", "climb flight level 80" above the transition altitude, "wind 270 degrees 12 knots", "holding point", "QNH 1013") and call each unit by its real name (Heathrow Director, London Control, Salzburg Radar, Wien Radar, Juliana Approach, San Juan Center). Pilots, the coach and the AI controllers all switch; both wordings are understood from you.
- **Procedures (`public/procs.js`):** arrivals route over their entry fix (STAR) and never descend below the terrain on their own; departures fly the published turn after takeoff (Salzburg 15: an early right turn toward FREIL, away from the Untersberg); a go-around flies the published missed approach (altitude, turn, waypoints, then a hold when you're working it) until you give a vector.
- **Terrain:** real peaks around each airport, drawn on the radar with their height. Minimum vectoring altitudes come from them; the coach and the AI never vector below them. The radar's **low altitude alert** (LA on the data block, MSAW) fires when an aircraft is, or in 30 s will be, below the minimum; say "low altitude alert, check your altitude immediately, climb and maintain …". Too close to a mountain, the crew's own terrain warning makes them climb (a penalty). Salzburg lands on runway 15 (its ILS) unless the tailwind is over 10 kt.

## Weather and light

**Weather** in the setup: **Live** uses the airport's real METAR (from aviationweather.gov through the game server, refreshed every 5 minutes; a new report changes the ATIS letter), in AI traffic and VATSIM modes alike. **Chosen** lets you pick clear, cloudy, rain, thunderstorms, fog, snow or strong wind; it is written as a METAR and used exactly the same way. If the live report can't be fetched, the shift uses chosen weather.

What follows the weather:

| Report | In the game |
|---|---|
| Wind, gusts | runway direction (by the wind), wind in clearances and the ATIS in real degrees, aircraft drift and crab, wind-corrected vectors from the coach, groundspeed on final and on the takeoff and landing rolls, gust additive on final, crews going around beyond their tailwind or crosswind limits |
| Visibility, RVR, cloud | low visibility procedures below 600 m RVR or a 200 ft ceiling; visual approaches only in visual conditions; fog and mist on the airfield |
| Rain, snow, thunderstorms | rain or snow falling, snow on the grass, longer landing rolls on wet or snowy runways; storm cells on the radar with deviation requests; lightning |
| Altimeter / QNH, temperature | ATIS, the setting given on first contact with Approach, takeoff acceleration |

**Time of day**: real time uses the sun's position for the airport's place and the game clock (sunrise, day, golden hour, sunset, dusk, night), dimmed by cloud, rain and fog; or pick sunrise, day, sunset or night. At night the apron floodlights, terminal, runway and taxiway lights, approach lights (with the sequenced flashers), PAPI, red stop bars, the lit streets around the field and the aircraft's landing, taxi and navigation lights come on. Shadows fall away from the sun.

## Settings in `.env`

| Setting | Default | |
|---|---|---|
| `PILOT_BACKEND` | `api` if a key is set, else `cli` | `cli` = Claude Code on your login |
| `PILOT_MODEL` | `claude-haiku-5-5` | `claude-sonnet-5-5` is richer, slower and pricier |
| `CLI_POOL` | `2` | how many `claude` processes stay open |
| `VOICE_ENGINE` | `local`, or `elevenlabs` if its key is set | |
| `ELEVEN_MODEL` | `eleven_v4_turbo` | `eleven_flash_v2_5`: half price, a little flatter |
| `PORT` | `8787` | |

## Test without Claude

`npm run mock` runs stand-in crews and test tones, to check the game, the radio chain and your microphone.

## Files

- `play.bat` — start the game
- `public/index.html` — the game and flight simulation
- `public/crew.js` — crews: personas, voice casting, the radio audio chain, chatter
- `server.mjs` — local server: serves the game, talks to Claude and the voices
- `lib/brain.mjs` — Claude prompts, and the checks on every reply
- `lib/cli.mjs` — the pool of warm Claude Code processes
- `lib/piper.mjs`, `lib/vctk-speakers.json` — the free local voices and each speaker's accent
- `lib/voices.mjs` — voice casting list and speech, local or ElevenLabs

Voices: Piper (MIT) with the `en_GB-vctk-medium` model, trained on the CSTR VCTK corpus (CC BY 4.0).
