# Urban Reign Redux 0.4 — October 3, 2026

[Download 0.4 + Textures (1.75 GB)](https://drive.google.com/file/d/127deHyx4wlYcyniWvTe1pl8oEXROJMxh/view) · [Release page](https://github.com/Jasonafex/urban-reign-redux/releases/tag/v0.4.0)

Complete manual package: ISO, 167 textures, ExtraMemory game setting, setup instructions and checksums. The earlier Auto-Installer is a separate legacy release.

## Changes since the 0.3 manual release

### Voices and audio
- Added independent combat and announcer voice banks for Baek, Nina and Carl Johnson, plus SPA and Fighter File recordings across the current roster.
- Missing SPA lines use heavy attack recordings; missing Fighter File lines use taunts.
- Repaired expanded voice tables overwriting other sound categories, including footsteps playing attack voices.
- Fixed loading/classification of added voice streams, unintended random SPA skips, and short attack voices blocking the same fighter's SPA recording.
- Corrected Baek damage samples and shared sample aliases; added the tested Free Mode narration guard.

### Combat and movesets
- **Nina:** new normal strings, running-up attack, SPA sequences, directional throws and Twisted Mind. More hitstun on selected later contacts; revised knockback finishers, side-string reactions and final-lunge recovery. Slower first up/side startup. Twisted Mind has more startup travel and now retains a 25% recovery reduction. SPA3 is red attack-boost mode.
- **Baek:** new normal/green strings, running attacks, SPAs and throws. More hitstun on selected later contacts; revised knockback, medium-stun and spike finishers. Running-up has doubled forward movement and launches. Green side uses the revised 10-hit route plus Double Claymore; green low uses Snake Kick → Baek's Rush Low → Snake Rocket. SPA2 is 12% faster and ends with heavy horizontal knockback.
- **Cammy:** updated directional throws, including only the first Double Heel Hold stage before release; string/SPA timing corrections retained.
- **Heihachi:** updated directional throws and paired recovery/getup alignment.
- **Hwoarang:** corrected right stance; SPA3 now gives purple attack boost + counter.
- **Violet:** revised neutral/down timing, up-string forward travel, back landing and kip-up recovery.
- Included further combat/recovery and paired-grab endpoint corrections for Leon, Kiryu, Jin and Heihachi.

### Models and presentation
- Integrated returned Violet, Paul and Nina model repairs and Carl Johnson's face repair with matching texture updates.
- Fixed Baek's stretched gi-trim UVs and hair/belt swing binding.
- Added the supplied Baek, Nina, Paul, Kazuya and Carl Johnson selection portraits.
- Reverted the experimental healthbar skin; faulty healthbar replacements are omitted.

### Known issues
Some model UV/shading defects and Nina's speaking animation remain. Nina's final side-string follow-through can still need adjustment after knockback. Audio routing and Baek SPA stream loading were checked, but audible playback and scene-transition testing are not exhaustive; occasional audio issues may remain.

**Fresh-boot 0.4. Do not resume an older emulator save state.** Memory-card saves may still be used.

ISO SHA-256: `b96fb209c87f9546377a5139381e4452b16acd4031aa66a09fd885549ce5dca3`

ZIP SHA-256: `b475e759e311b36a8c8a7f98b9834a97c40dee4b59e2449096bb724e92ed2977`

---

# Earlier release history

# Urban Reign Redux 0.2 Alpha

## Public download refresh — 2026-09-30

- Auto-Installer now downloads the latest Trial 13 game patches, including the installed character repairs, combat changes, glasses-stability baseline and Jack jaw fix.
- Refreshed the core, all 21 character packages, music package, Mod Manager, optional Editor and runtime setup. Installer is approximately 55 MB; selected content downloads separately.
- Full selection reproduces the installed Trial 13 ISO byte-for-byte. Core-only and Kazuya-only builds also passed character-layer checks.
- Character-specific attack, idle, throw and green-SPA routing follows the selected character packages. Skipped replacements retain their native routing.
- Download names are versioned and verified by SHA-256. Existing installers keep their original package URLs; download the new installer to update.
- Run the current installer again with your chosen characters, then rebuild using your supported original ISO or retained original backup. Fresh-boot the result. Existing user-edited source mods are preserved.
- This refresh distributes implemented changes; outstanding items in the combat patch notes remain unfinished.

## Combat playtest update — 2026-09-29

Trial 13 combat update; [full patch notes](docs/patch-notes/2026-09-29-combat-playtest.md). Included in the September 30 public download refresh.

## Installer reliability update — 2026-09-26
- Installer is approximately 43 MB; optional content still downloads only when selected.
- USA CHD support: conversion is automatic, the input is preserved, and output is a separate ISO. The supplied single-track MODE1/2048 USA CHD passed conversion and a full build.
- Verified executable recovery preserves approved character selections while retaining source checks and output verification. Unrecognized character data is refused.
- Persistent installer/build logs with a Support logs button in Mod Manager and clickable installer error text. Log contents redact the Windows user-profile path.
- Clear rejection for European and Japanese editions. Regional ports are deferred.
- Fresh installation and Deluxe build passed. Original source images were not changed.
- Bundled CHD converter: unmodified MAME 0.289 chdman; notices ship with it and corresponding source is available in the component release.



## Lean installer update — September 26, 2026
- Auto-Installer is about **30 MB**, down from 1.02 GB. Mod Manager is bundled; selected content downloads automatically.
- Required default textures/intro stay checked. Character mods and music are on by default. **Advanced** offers individual character selection; **Editor** is last and off by default.
- Separate character packages include their HD textures. Skipped characters use their original fighters, and duplicate original entries are removed from character select.
- Downloads are verified and cached. Interrupted downloads resume; damaged cached files are downloaded again.
- Installer styling now matches Mod Manager, with readable visual strips on every page.
- PCSX2 Documents/OneDrive detection, memory/runtime setup, desktop shortcuts and optional Windows-startup shortcuts remain automatic.
- The shared patch reuses unchanged data from the player's ISO instead of redistributing it. Selecting all characters/music recreates the existing v0.2 game image byte for byte.
- Full, single-character and core-only installs were checked. The Editor and Mod Manager build paths were checked; no emulator was launched in this packaging pass.
- This update does not repair the remaining model issues below.

## Added
- Expanded fighter selection: the release collection adds its custom fighters alongside the original roster instead of replacing their slots.
- Expanded, paged stage selection with story-mode locations available in multiplayer.
- Smaller battle HUD, hidden player indicators, and multiplayer camera controls. L3 follows the player using that controller; R3 restores the shared camera.
- Updated Challenge mode presentation.
- First working mouth-animation pilot for Leon, Cammy and Violet, using the optimized Brad mouth donor. Eye and blink work remains deferred.
- PCSX2 setup built into the launcher and editor: saving the emulator selection or building the supported expanded ISO installs the matching runtime patch, enables extra memory and cheats for that game, and installs the bundled HD texture replacements. Custom PCSX2 folders are respected; changed files receive backups.
- A complete Redux 0.2 collection build in the editor's Settings, plus a separate runtime setup utility for existing expanded images.

## Included model updates
- Cammy's earlier chest repair and Bryan's hair repair are retained.
- Marduk's lowered crotch correction is retained.
- HD textures are delivered with their selected characters; unused older texture aliases are omitted.

## Known issues
- Violet still deforms around his gloves/hands and open shirt in some poses. Collar gaps and tooth visibility still need work.
- Marduk's waist and underarms still deform in some poses.
- Cammy's mouth opening is subtle and her chin/face shading needs further polish. Leon's mouth motion works, but the inner-mouth color is still bright.
- Further hair-card, glasses-transparency, clothing and weapon-grip polish remains pending. This release does not claim those issues are fixed.
- Mouth animation is a three-character pilot, not a roster-wide facial-animation update.
- This is an Alpha release. Additional stage, camera and multiplayer compatibility testing is welcome.

## Installation
Download **[Auto-Installer.exe](https://github.com/Jasonafex/urban-reign-redux/releases/latest/download/Auto-Installer.exe)**, run it, and follow the **[picture guide](https://jasonafex.github.io/urban-reign-redux/install/)**. Character mods and music are selected by default; Editor is unchecked. Use Advanced to select individual characters. Default textures and intro cannot be unchecked. Setup needs internet.

Choose your PCSX2 program folder during setup. Setup finds Documents/OneDrive or portable data and respects custom cheat/texture folders. Close PCSX2 before setup writes its files. Desktop shortcuts are offered and opening Mod Manager at Windows login is opt-in.

Open Mod Manager, choose your supported original ISO, keep **Clone** and **Redux 0.2 Collection** selected, and apply. Cold-boot the resulting `-modded.iso`; do not resume an old save state. PCSX2 2.7.403 with ExtraMemory support is the tested configuration.

Editor users can choose **Settings → Build Redux 0.2 collection**. Normal authoring builds remain separate from the complete release collection.

Runtime setup is bundled and runs automatically; no separate runtime download is needed. It is scoped to v0.2 (SLUS-21209 / AAC5DB56). ISO-based setup checks the executable against the release, allowing only the verified character-selection data changes before installing address-specific patches.

A game ISO and PCSX2 are not included. The builder accepts the previously supported USA and Deluxe hashes. The verified Deluxe rebuild matched the installed test image byte for byte; a fresh clean-USA rebuild was not performed in this release pass.

### Picture guide update

- Added simplified visual slides to matching installer steps, the download page, and README. Click a slide to enlarge it.
- New Mod Manager setups default to Overwrite with an original backup; existing saved build-mode choices are preserved.
- Installer is approximately 38 MB including the offline visual guide.
