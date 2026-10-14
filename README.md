![Urban Reign Redux](docs/assets/logo.png)

# Urban Reign Redux 0.4

More fighters, revised movesets, new voices, music and menus for Urban Reign. A community project by **Jasonafex**.

## Download

**[Download 0.4 + Textures — complete manual package, 1.75 GB](https://drive.google.com/file/d/127deHyx4wlYcyniWvTe1pl8oEXROJMxh/view)**

[Full patch notes since 0.3 and checksums](https://github.com/Jasonafex/urban-reign-redux/releases/tag/v0.4.0) · [Project website](https://jasonafex.github.io/urban-reign-redux/) · [Report an issue](https://github.com/Jasonafex/urban-reign-redux/issues)

Released October 3, 2026. The Google Drive download is available to anyone with the link; no sign-in is required.

The ZIP includes:
- Urban Reign Redux 0.4.iso
- 167 matching replacement textures
- PCSX2 ExtraMemory game setting
- START HERE.txt, patch notes and SHA-256 checksums

Supply your own PCSX2 installation and BIOS. **No mod installer or Editor is required.** The earlier September 30 Auto-Installer does not install this 0.4 build.

## Manual setup

1. Extract the ZIP, read **START HERE.txt**, and put the new ISO in your games folder.
2. Close PCSX2. Merge the supplied game setting into its data folder and install the included textures. Back up older Redux texture packs outside the active texture folder to avoid conflicts. Enable **Load Textures**.
3. **Fresh-boot the new ISO. Do not resume an older emulator save state.** Memory-card saves may still be used.

This is the USA SLUS-21209 build. PCSX2 must support ExtraMemory; tested with PCSX2 2.7.403.

## What's new since 0.3

- Independent Baek, Nina and Carl Johnson combat/announcer banks; new SPA and Fighter File recordings with heavy-attack/taunt fallbacks.
- Expanded voice-table and sound-routing repairs, added stream loading fixes, and SPA voice admission corrections.
- Nina and Baek moveset revisions, stronger later-string hitstun, updated finishers, throws and SPAs.
- Hwoarang right stance and purple SPA3; Violet timing, movement and kip-up corrections; Cammy/Heihachi throws and further combat/grab recovery fixes.
- Updated Violet, Paul and Nina models, Carl Johnson face repair, Baek gi-trim UV/swing fixes, and new selection portraits.
- Experimental healthbar skin reverted.

See the [complete release notes](https://github.com/Jasonafex/urban-reign-redux/releases/tag/v0.4.0) for character-specific changes. Some model UV/shading defects, Nina's speaking animation and side-string follow-through remain; audible playback and scene-transition testing are not exhaustive.

## Web client — Urban Reign Web

This repository also hosts **urban-reign-web**, a deterministic 60Hz 3D multiplayer brawler engine for the browser, modelled on Namco's 2005 Urban Reign: four fighters in an urban arena, directional chain combos, high/low dodges with frame-perfect reversals, grabs, juggles, Special Arts, a match clock, and rollback netcode for playing over the house LAN.

```bash
npm install
npm run dev        # http://localhost:5173 (also exposed on the LAN for phones/tablets)
npm run typecheck  # gate 1 — tsc --noEmit
npm test           # gate 2 — determinism, replay and architecture suite
npm run build      # gate 3 — tsc && vite build
npm run report     # gate 4 — declared vs measured frame data, exits non-zero on any discrepancy
```

### Playing in a browser

Open the page and press a movement key or an action button — the first device you touch claims slot 1, and each additional device claims the next free slot (up to four). Unclaimed slots stay on the board as idle fighters until you fill them with CPUs.

Pick a match with the control strip in the bottom-left corner, or from the keyboard:

| Key | Action |
| --- | --- |
| `M` | Switch between **4-Player Free-For-All** and **2v2 Team Battle** |
| `B` | CPU fill — cycles `0 → 4 → 0`, seating a CPU in every unclaimed slot |
| `R` | Call a rematch on the victory screen |

A CPU always yields its slot to a real device, so turning the fill on never stops a second player joining.

Match URL flags:

| Flag | Effect |
| --- | --- |
| `?mode=free_for_all` | 4-player free-for-all (default) |
| `?mode=team_battle` | 2v2 — slots 0 + 2 against slots 1 + 3, no friendly fire |
| `?lan` | Host a house-LAN session |
| `?join=<host>` | Join a house-LAN relay at that host |

The flags combine, so a phone can open a 2v2 LAN match straight from a QR code.

#### Controls

Two split-keyboard layouts, disjoint by key so two players can share one keyboard without either one's guard press leaking into the other's stick:

| Action | P1 · WASD + JKL | P2 · Arrows + Numpad |
| --- | --- | --- |
| Move | `W` `A` `S` `D` | Arrow keys |
| Strike (chain opener) | `J` | `Numpad1` |
| Grab | `K` | `Numpad2` |
| Special Art | `L` | `Numpad3` |
| Guard high | `Left Shift` | `Numpad4` |
| Guard low | `C` | `Numpad6` |
| Dodge high | `U` | `Numpad7` |
| Dodge low | `I` | `Numpad9` |
| Target lock | `O` | `Numpad8` |

Combat follows the arcade original: `strike` walks the four-way directional chains (neutral, up, down, side), and a press made during a hit-confirm window branches into the next link. A dodge timed inside its first few frames becomes a **reversal** — it does not merely evade, it counters.

#### Gamepads

Up to four Standard-mapping pads, claimed in index order:

| Action | Button |
| --- | --- |
| Strike | `A` / Cross |
| Grab | `X` / Square |
| Special Art | `Y` / Triangle |
| Guard | `B` / Circle — plus stick-down for the low guard |
| Dodge high / low | `LB` / `RB` |
| Target lock | `LT` or `L3` |

#### Touch

Phones and tablets get an on-screen arcade pad on first touch: a thumbstick on the left, and `STRIKE`, `GRAB`, `SPA`, `GUARD`, `DODGE-HI`, `DODGE-LO` and `LOCK` buttons on the right. It appears on any device with a touchscreen, including a desktop with a touchscreen.

#### House LAN

Four devices on the same Wi-Fi can play together over a local relay:

```bash
npm run lan-server   # relay, prints its LAN addresses
```

Open `http://<your-lan-ip>:5173/?lan` on the host. A panel in the top-right shows the join link and a **QR code** — anyone in the house can scan it with a phone and join without typing an IP address. The host applies its own input immediately and predicts everyone else's, rolling back and re-simulating when a packet corrects a guess; the readout shows latency, jitter and rollback count live.

### Architecture

The simulation (`src/sim`, `src/combat`, `src/core`) is DOM-free and integer fixed-point, so the same sources run unchanged in the browser, in the test runner and in the balance report. Game modes and the match lifecycle live in `src/sim/modes.ts`; the CPU opponent is `src/sim/ai.ts`, a pure function of `(seed, slot, tick, world)` so it is replay- and rollback-safe. See [`AGENTS.md`](AGENTS.md) for the architecture and gate definitions.

## About

[Explore the project and screenshots](https://jasonafex.github.io/urban-reign-redux/) · [Release history](CHANGELOG.md)

This repository hosts the release, website and setup support. It does not include the editor's complete source. No blanket license is granted to third-party game or character assets. Not affiliated with or endorsed by the original game's publisher.
