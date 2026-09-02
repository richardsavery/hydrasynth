# Live sonification input

## Existing transport

RAPP Realtime already exposes the right live transport. Its bridge and replay
player broadcast one JSON object per WebSocket message, normally on:

```text
ws://localhost:8765
```

The live robot and `viz_student_pack/player.py` use the same message shapes as
the JSONL recordings. A connection may first receive a status message:

```json
{"channel":"__status__","msg":"connected","server":"vam_player"}
```

All other messages identify their stream with `channel`; numeric content is
either a labelled top-level `data`/`velocity` array or named arrays under
`tensors`. The replay server is latest-frame-wins per channel, so a slow client
does not accumulate an unbounded backlog.

## Dashboard integration

The dashboard should add **Live WebSocket** beside the recorded-file source.
This can be implemented directly in the browser, so the local Python dashboard
does not need a WebSocket dependency or proxy.

1. Default the address to `ws://localhost:8765`, while allowing a workshop host
   address on the local network.
2. Validate each received JSON object and pass it through the same field
   discovery and tensor-reduction rules used for recordings.
3. Keep a bounded rolling buffer per mapped signal (720 reduced values is
   consistent with the recorded view). Never retain full activation tensors.
4. Let the musical clock sample the latest reduced values at the selected tempo.
   Do not generate one note per network frame; channel rates differ and may be
   much faster than a useful musical pulse.
5. Normalise against a rolling window, with a short warm-up state before notes
   begin. Preserve the user's curve and output-range settings.
6. Reconnect with bounded backoff, show `connecting`, `live`, `stale`, and
   `disconnected` states, and send MIDI all-notes-off if the stream disappears.
7. Ignore `__status__` for sonification but surface its message in connection
   status. Bound message size and reject malformed channels or non-finite data.

## Acceptance criteria

- The dashboard can connect to the real robot stream and to `player.py` without
  changing mappings.
- Newly observed channels and fields become available without a page reload.
- The rolling waveform and values update while the stream is live.
- Browser preview and Hydrasynth MIDI use the same live mappings.
- Disconnecting or changing source cannot leave a held MIDI note.
- A high-rate activation stream cannot grow browser memory without bound.

This is deliberately the next feature rather than a second transport: recorded
and live modes will share one message schema, one reduction layer, and one
sonification engine.
