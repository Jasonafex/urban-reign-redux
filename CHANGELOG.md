# Urban Reign Redux 0.2 Alpha

## Installation update — September 26, 2026
- One **Auto-Installer.exe** replaces the separate player, editor, launcher and runtime downloads.
- Mod Manager, Editor (Optional) and Mods are checked by default. All release content is bundled.
- Automatic PCSX2 program/data-folder setup, including Documents/OneDrive, memory/runtime patches and HD textures.
- Optional desktop and Windows-startup shortcuts, plus an offline picture guide and a Picture guide button in Mod Manager.
- Direct DOWNLOAD buttons on GitHub and the project website.
- This packaging update does not change the game models or resolve the known issues below.

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
- The collection includes the current 167 replacement texture files.

## Known issues
- Violet still deforms around his gloves/hands and open shirt in some poses. Collar gaps and tooth visibility still need work.
- Marduk's waist and underarms still deform in some poses.
- Cammy's mouth opening is subtle and her chin/face shading needs further polish. Leon's mouth motion works, but the inner-mouth color is still bright.
- Further hair-card, glasses-transparency, clothing and weapon-grip polish remains pending. This release does not claim those issues are fixed.
- Mouth animation is a three-character pilot, not a roster-wide facial-animation update.
- This is an Alpha release. Additional stage, camera and multiplayer compatibility testing is welcome.

## Installation
Download **[Auto-Installer.exe](https://github.com/Jasonafex/urban-reign-redux/releases/latest/download/Auto-Installer.exe)**, run it, and follow the **[picture guide](https://jasonafex.github.io/urban-reign-redux/install/)**. All three components are selected by default; the Editor is optional.

Choose your PCSX2 program folder during setup. Setup finds Documents/OneDrive or portable data and respects custom cheat/texture folders. Close PCSX2 before setup writes its files. Desktop shortcuts are offered and opening Mod Manager at Windows login is opt-in.

Open Mod Manager, choose your supported original ISO, keep **Clone** and **Redux 0.2 Collection** selected, and apply. Cold-boot the resulting `-modded.iso`; do not resume an old save state. PCSX2 2.7.403 with ExtraMemory support is the tested configuration.

Editor users can choose **Settings → Build Redux 0.2 collection**. Normal authoring builds remain separate from the complete release collection.

Runtime setup is bundled and runs automatically; no separate runtime download is needed. It is scoped to v0.2 (SLUS-21209 / AAC5DB56). ISO-based setup checks the complete executable hash before installing address-specific patches.

A game ISO and PCSX2 are not included. The builder accepts the previously supported USA and Deluxe hashes. The verified Deluxe rebuild matched the installed test image byte for byte; a fresh clean-USA rebuild was not performed in this release pass.
