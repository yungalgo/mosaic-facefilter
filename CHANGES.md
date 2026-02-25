# Changes since fork

This doc describes the **privacy-hardening** features added after the original mosaic filter. The goal: make it much harder for someone to “undo” the effect by averaging or analyzing many frames of video.

---

## What’s new (at a glance)

- **Two separate random “keys”** — one for face shape, one for tile colors. They change on their own timers so the output keeps shifting.
- **Face shape wobble** — the mesh is slightly warped at random (lumps, bumps). The warp changes every so often and blends smoothly so it doesn’t look jumpy.
- **Tile scrambling** — mosaic blocks swap places and their colors get tweaked so the image doesn’t match the real face layout. This also changes on a timer.
- **Short black flash** — when the color key changes, the face tiles briefly go black (about 80 ms). Only the face; the green background stays for OBS. Then it goes back to normal.
- **Shared quad buffer** — one GPU buffer is reused for all fullscreen draws instead of creating/destroying one every frame (small performance win).

---

## 1. Two keys instead of one

We use two independent random keys:

- **Geometry key** (`subKeyGeom`) — only affects the **shape** of the face (the vertex wobble).
- **Color key** (`subKeyColor`) — only affects **tile scrambling and color** (which block shows what, and the color tweaks).

They’re separate so that shape and color don’t give away each other’s pattern. Each key:

- Starts with fresh random data when the app loads (no “empty” first second).
- Gets replaced with new random data on a **timer**. The timer isn’t fixed: we add a bit of random jitter so the timing isn’t predictable.

**Where to look:** `src/renderer/app.js` — search for `subKeyGeom`, `subKeyColor`, `rotateGeomKeyIfNeeded`, `rotateColorKeyIfNeeded`.

**Settings you can tweak:**

- `SUBKEY_ROTATE_MS` — how often (in ms) we *roughly* rotate (default 1000).
- `JITTER_MS` — random variation added to that interval (default 300), so rotation might happen between ~850 ms and ~1150 ms.

---

## 2. Face shape distortion (geometry)

The face mesh isn’t drawn exactly where the tracker says. Each point is nudged by a small random amount (in x, y, and z). So the face looks slightly lumpy or warped — still recognizable as a face, but not your real proportions.

When the **geometry key** rotates, we compute a new set of nudge values. Instead of snapping to the new shape, we **blend** from the old shape to the new one over a short time (e.g. 200 ms). That way you see a smooth morph instead of a pop.

**Where to look:** `generateDisplacementField`, `displaceCurr` / `displacePrev`, and the vertex loop in `renderFaceMesh` where we add `dx`, `dy`, `dz`.

**Settings:**

- `DISTORT_AMPLITUDE` — how big the nudge is (default 0.012 = about 1.2% of face size). Bigger = more warped.
- `GEOM_HYSTERESIS_MS` — how long (ms) the blend from old shape to new shape takes (default 200).

---

## 3. Tile scramble and color tweaks

After we downsample the face to a grid of chunky tiles, we run a **scramble** step before blowing it back up:

1. **Swapping tiles** — each tile doesn’t necessarily show the piece of face that’s “under” it. We pick a random neighbor and sample from there, so the mosaic is shuffled.
2. **Color tweaks** — we shift the red/blue/green a bit per tile and pull down green so it doesn’t blend into the green screen. That way the colors don’t match real skin tones.

Both the swap pattern and the color tweaks come from the **color key**. When that key rotates, the scramble pattern and colors change.

**Where to look:** `fragmentShaderScramble`, `drawScramblePass`, and the pipeline in `renderPixelatedFace` (downsample → scramble → upsample).

---

## 4. Black-tile flash (boundary mask)

When the **color key** rotates, we don’t just switch the pattern instantly. For a very short time (default 80 ms), we **fade the face tiles to black**, then fade back to the new scrambled image. So you get a quick black flash on the face only; the green background (or the rest of the scene) doesn’t change. OBS chroma key still works.

That flash makes it harder to line up “before and after” frames, which helps privacy.

**Where to look:** `getBoundaryMask`, `boundaryMaskTs`, and in the scramble shader the line that does `mix(color, vec4(0,0,0,1), uBoundaryMask)`.

**Setting:**

- `MASK_MS` — how long (ms) the face stays black after a color-key rotation (default 80).

---

## 5. Where everything lives

- **Config** — all the numbers above are in one block at the top of `src/renderer/app.js` (around lines 30–52). Comments there say what each one does.
- **Scramble** — we added a new shader program `programScramble` and a framebuffer `fboScramble` / `texScramble`. The scramble pass draws into that, then we upsample from it.
- **Shared quad** — a single buffer `quadVBO` is created once in `initWebGL` and reused for every fullscreen draw (blit, masked video, scramble). No per-frame create/delete.

---

## Quick reference: settings

| Constant | Default | What it does |
|----------|----------|--------------|
| `DISTORT_AMPLITUDE` | 0.012 | How much the face shape is warped (bigger = more lumpy). |
| `SUBKEY_ROTATE_MS` | 1000 | Target time (ms) between key rotations. |
| `JITTER_MS` | 300 | Random variation (ms) so rotation isn’t on a fixed schedule. |
| `GEOM_HYSTERESIS_MS` | 200 | How long (ms) the shape morphs when the geometry key changes. |
| `MASK_MS` | 80 | How long (ms) the face goes black when the color key changes. |

If you turn up `DISTORT_AMPLITUDE` or turn down `SUBKEY_ROTATE_MS`, the effect is stronger but the video looks more distorted or flashes more often.
