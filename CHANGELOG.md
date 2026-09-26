# Urban Reign Redux 0.2 Alpha

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
