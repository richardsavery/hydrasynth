# Local audio pitch dependency

`soundtouch-2.1.1.js` is the bundled processor distributed in
[`@soundtouchjs/audio-worklet` 2.1.1](https://www.npmjs.com/package/@soundtouchjs/audio-worklet/v/2.1.1),
by Steve “Cutter” Blades and the SoundTouchJS contributors, licensed under
[MPL-2.0](soundtouch-LICENSE.txt).

Upstream source: <https://github.com/cutterbl/SoundTouchJS>.
Package archive: <https://registry.npmjs.org/@soundtouchjs/audio-worklet/-/audio-worklet-2.1.1.tgz>.
The archive's npm integrity is
`sha512-itxSW62gbtDKoFo6eEr4PXzVz3oF+wCVREupFi5JiUR31tWWwCizr+2XezYD1SnkrSDfdmZvvviTtoyejYeD0Q==`.

The bundle is readable source. Its accompanying source map includes the original
TypeScript sources. Local changes to this bundle are limited to an attribution
header, the local source-map filename, and `export { SoundTouch }` for the wrapper.
No runtime CDN, npm install, provider calls, or audio uploads are required.

## Integration and timing

`../audio-pitch-worklet.js` wraps the upstream WSOLA stretch and Lanczos
transposition stages. The source node controls speed; the processor uses
`2 ** (pitchSemitones / 12) / playbackRate` to counteract the speed-induced pitch
change and apply independent tuning. Combined master/stem tuning supports
−24…+24 semitones at source speeds 0.75…1.25.

All paths use a common nominal delay of `ceil(sampleRate * 0.256 / 128) * 128`
samples. Neutral processing is a sample-exact delayed bypass. The player accounts
for this buffering in its audible transport and crossfades. WSOLA chooses
waveform overlaps, so individual transients may move by tens of milliseconds
(roughly 90 ms at the most extreme combined settings). This is an estimated
tempo grid, not detected beat alignment or phase-perfect stem reconstruction.

The wrapper fixes the stage order at Stretch → Transpose on both sides of unity
and preserves fractional sample consumption during updates. This prevents the
upstream dynamic pipeline reorder from reinterpreting pending samples during
frequent signal-driven sweeps. A rolling input history and short crossfade can
restore the buffering budget during sustained extreme modulation, bounding the
queue without inserting silent blocks. These adaptations are specific to the
pinned upstream implementation; re-run `tools/test_audio_pitch.js` and browser
audio checks before updating it.

Offline stereo-tone tests cover independent speed/tuning and absence of output
gaps; neutral-delay tests verify exact sample correspondence; a fifteen-minute
rapid-modulation test exercises queue recovery. Pitch shifting still has the
normal timbral/transient artifacts of real-time time stretching, particularly
at octave extremes. It does not attempt formant preservation.
