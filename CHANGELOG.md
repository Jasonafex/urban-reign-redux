# Urban Reign Redux 0.2 Alpha

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
1. Extract the player ZIP and keep the launcher installer beside its `mods` folder.
2. Install the launcher, select your supported original ISO, and select your PCSX2 installation or data folder. Close PCSX2 while setup writes its files.
3. Select **Redux 0.2 Collection** on its own. Do not combine it with the old character-replacement packs. Choose Clone or Overwrite, then build.
4. The launcher verifies the image and installs the companion files automatically. Cold-boot the resulting ISO in PCSX2; do not resume an old save state. The local test setup uses PCSX2 2.7.403 with ExtraMemory support.

The optional editor installer includes the same collection. In Settings, save your emulator executable, then choose **Build Redux 0.2 collection**. The normal authoring build still builds the selected replacement mods; it is separate from the fixed release collection.

Existing users can run `ReduxRuntimeSetup.exe` from the runtime ZIP and choose their PCSX2 folder. The utility is scoped to the v0.2 executable (SLUS-21209 / AAC5DB56). ISO-based setup verifies the complete executable hash before installing address-specific patches. Unknown expanded builds are rejected. No emulator is included or launched by setup.

A game ISO is not included. Keep your own original, any `.iso.original` backup and the `.studio.json` record. The builder accepts the previously supported USA and Deluxe hashes; the fresh build verification for this release used the verified Deluxe source and matched the installed test image byte for byte. A fresh clean-USA rebuild has not been performed in this release pass.
