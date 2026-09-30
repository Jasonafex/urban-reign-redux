# Combat playtest update — September 29, 2026

This update is installed locally as **Trial 13 Combat Follow-ups**. The public 0.2 Alpha installer is unchanged; this commit documents the playtest and preserves its combat implementation. It is not a new public binary release.

## Combat and recovery
- Imported final attacks retain their full recovery, including authored get-up sequences. Added a guard against cancelling terminal recovery with another SPA.
- Replaced the incorrect low-corkscrew reaction on designated high launchers with Park's native back-turned up-attack launch reaction. Jack's neutral third hit also uses the upward launcher.
- Green-mode routing uses the actual active moveset. Jin returns to Kadonashi's extended strings in green mode, with custom base strings restored afterward.
- Jin's green SPA 2 now completes its full sequence when its opening misses. The native short miss exit was removed for Jin only; the gauge cost is charged once.
- Imported paired throws retain the intended victim animation rather than releasing it prematurely.

## Latest fighter adjustments
- **Jack 5:** Gigaton gains 40% base damage per additional completed windup, up from 20%, with five charge levels and one gauge cost. Neutral string is 10% faster. Low attacks have slower startup, longer recovery, a low-sweep finish and less opener travel. SPA 2 has increased early travel/contact range and faster recovery; the third hit uses x2.3 travel and the finisher has 25% less travel. Corrected excessive jaw displacement in pain animations.
- **Leon:** Brad's three opening punches use native continuation timing. Southern Cross and the final five side-string hits have revised contact spacing against the supplied animation references. Knee Vault uses an upward launch, a 50% larger contact radius and 25% faster recovery. The side finisher retains its full kip-up recovery.
- **Bryan:** Middle neutral/up hits use the longer native standing stagger where they previously used light reactions. The opening up kick is a medium with 10% slower startup. SPA 1 is 25% faster except for the finisher.
- **Jin:** Fourth neutral hit has 35% less recovery. Green SPA 2 miss-exit fix described above.
- **Hwoarang:** Up and down strings restored to native defaults; custom side string retained.
- **King:** First three green-mode low hits have 25% slower startup and 25% faster recovery.
- **Armor Queen:** Green neutral's penultimate hit uses the corrected high-launch reaction.
- **Kiryu:** Retains the character-specific reference idle and the existing imported-string/get-up work.
- Existing electricity effects and glasses-stability baseline are preserved.

## Validation
- Combat payload and ISO layout checks passed; bytes outside the combat executable and eight Jack jaw-model copies were unchanged from the build baseline.
- Jack's neutral and side launchers triggered the native Park reaction in controlled emulator tests. All five Gigaton charge paths completed and charged the gauge once.
- Jin's green SPA 2 completed all ten actions both at close range and with its opening deliberately missing.
- Leon's complete neutral and side paths passed sequence checks. His terminal recovery reached its final frame under repeated attack input.
- These checks do not constitute exhaustive multiplayer, spacing, or full-roster testing. Not every intended contact landed in the controlled Leon sequences.

## Still in progress — not claimed fixed in this build
- Asuka's chest/abdomen UV stretching.
- GIF-based timing corrections for King's green neutral/side, Armor Queen's green neutral, and Hwoarang's custom side string. References have been received.
- Complete fresh-selection validation for the remaining green-mode/Heihachi cases.
- Remaining community stage/selection/HUD bugs, outstanding character ports and user-edited voice replacements.

## Local build fingerprint
SHA-256: `69dea95ed3e3e537ca7b9a95d345221b8293f499a64570d3d07e7c609ddcc0c3`

The installed ISO is not distributed in this repository.
