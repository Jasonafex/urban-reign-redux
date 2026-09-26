# Redux 0.2 PCSX2 companion files

Use the runtime setup ZIP from the v0.2.0 release for the compiled utility and HD textures. The launcher and editor perform the same setup automatically. Close PCSX2 first.

Manual settings for the supported SLUS-21209 / AAC5DB56 build:
- Copy `AAC5DB56.pnach` to the configured Cheats folder.
- In `gamesettings/SLUS-21209_AAC5DB56.ini`, set `[EmuCore/CPU] ExtraMemory = true` and `[EmuCore] EnableCheats = true` (each section on its own line).
- Install the bundled PNGs in `textures/SLUS-21209/replacements` and enable texture replacements for this game.

Respect the custom folder paths in PCSX2's `[Folders]` settings. The utility handles those paths, backups and preservation automatically. Do not use this patch with an unrelated executable. No separate background script is needed: the runtime routines are contained in the PNACH patch.
