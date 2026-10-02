---
name: vidlint
description: Verify a rendered video before declaring it done. Use after every render of a generated or programmatic video (Remotion, Motion Canvas, ffmpeg, an export from any editor) to catch blank frames, a picture that froze while the audio kept playing, dead air, flash/strobe accessibility failures, silent or clipped audio, and wrong loudness. USE FOR: check the video, verify the render, QA the video, is the video good, why does the video look bad, the video is boring, review output.mp4, validate before upload, lint video, audit render.
---

# vidlint

A video you have never objectively measured is a video you are guessing about.

This skill exists because "render it and assume it is fine" is how broken output
ships. Rendering proves the pipeline ran. It does not prove the result is any
good. `vidlint` reads the rendered file and reports defects with timecodes and
numbers, so every claim about the video is checkable.

## The loop

Never declare a video finished without completing this loop.

1. Render the video to a file.
2. Run `npx vidlint <file> --verbose` (or `node bin/vidlint.mjs <file>` from a
   checkout).
3. If it reports **errors**, fix the cause and go back to step 1.
4. If it reports only warnings and info, decide deliberately whether to accept
   each one. Do not silently ignore them.
5. Only then report the video as done, and include the final vidlint summary as
   evidence.

A run that ends with warnings is a decision, not a pass. Say which ones you
accepted and why.

## Exit codes

The CLI is built for this loop:

| Code | Meaning |
| --- | --- |
| `0` | No errors. |
| `1` | Errors found. Fix them. |
| `2` | Usage error or the analysis itself failed. |

`--strict` also fails on warnings, which is usually what you want in CI.

## What each rule means and how to fix it

Work rule by rule. The `--json` output carries a `fingerprint` per defect, so
you can tell "the same problem, still there" from "a new problem" between runs.

### `frozen-with-audio` — the one that matters most

The picture stopped changing while the audio kept going. This is the signature
of a stalled render or a scene whose animation ended before its audio did.

**In Remotion this is almost always a length mismatch.** Fix it by making the
scene's animated span cover the audio:

- `durationInFrames` on the `<Sequence>`/`<Composition>` is shorter than the
  voiceover or music. Compare them and extend the scene.
- An `interpolate()` reaches its final value long before the scene ends, so the
  last N seconds are a static frame. Stretch the input range to the full scene
  duration, or add a second movement for the tail.
- A `useCurrentFrame()`-driven animation is gated behind a condition that stops
  being true (for example `frame < 60`), freezing everything afterwards.
- An `<Audio>` track is longer than the visual sequence it sits under.

### `dead-air`

A static stretch. Severity depends on the audio: the same freeze is an error
under speech and only informational in silence, because a held beat in silence
is a legitimate pacing choice.

If it is in silence and you want to keep it, that is fine — just say so. If you
want it gone, add continuous subtle motion (a slow drift, a push-in, a parallax)
so every frame differs from the last.

### `blank-frames`

The frame is one flat colour. In Remotion this usually means a `<Sequence>` has
no content for that span, an asset failed to resolve, or `calculateMetadata`
returned a duration longer than the scenes actually cover.

### `flash-risk`

More than three opposing luminance changes of 10% or more per second, where the
darker state is below 0.80 relative luminance and enough of the frame is
involved. This is the WCAG 2.3.1 / ITU-R BT.1702 photosensitivity threshold, and
it is a genuine accessibility hazard, not a style note.

Fix by reducing the number of opposing changes per second, narrowing the
luminance swing, or shrinking the flashing area. A hard cut between a black and
a white frame, repeated, is the classic offender.

### `too-quiet` / `too-loud` / `audio-clipping`

Integrated loudness is measured to EBU R128. The default target is **-14 LUFS**,
which is the usual delivery level for social and web. True peak should stay
below **-1 dBFS**. Adjust the mix rather than the video.

### `safe-area` (opt-in)

A distinct high-contrast element sits where the platform draws its own chrome
(captions, buttons, the progress bar). Enable with `--platform reels` (or
`tiktok` / `shorts` / `remotion`). The report gives you the offending region in
**composition pixels**, so you can move the element directly.

These presets are community-reported, not published platform specs. Treat them
as a starting point and verify on a device.

### `edge-clipping` (opt-in)

Structure in the outermost sliver of the frame. Enable with `--layout`. This is a
pixel heuristic and false-positives on busy full-bleed footage, which is why it
is off by default.

## Commands

```bash
# The everyday check
npx vidlint out.mp4 --verbose

# Machine-readable, for driving a fix loop
npx vidlint out.mp4 --json

# Fail CI on warnings too
npx vidlint out.mp4 --strict

# Vertical social: safe-area check plus a self-contained visual report
npx vidlint out.mp4 --platform reels --html report.html

# A contact sheet of the whole timeline, for looking at the video quickly
npx vidlint out.mp4 --sheet sheet.png
```

`--html` writes a self-contained page with the defect timeline and sampled
frames embedded. **Open it and actually look at the frames** — the numbers tell
you where to look, not what you will see.

## What vidlint cannot catch — read this before claiming a video is good

vidlint analyses **pixels and audio**. It cannot see your DOM, so it cannot tell
you that a headline overflows its container, that two elements collide, or that
text sits at 14px on a 1080p frame. Those are the defects most likely to make a
generated video look wrong, and they are invisible to any pixel heuristic.

A clean vidlint report means *the video is not broken*. It does not mean the
video is well composed. Do not present it as proof of quality.

For the layout class of bugs, use Remotion's own first-party tooling at author
time:

- `measureText()` — actual rendered text dimensions.
- `fillTextBox()` — returns `exceedsBox` when text will not fit.
- `fitText()` — the font size needed to fit a given width.

Two traps that make those measurements lie:

1. **Load fonts first.** Measuring before a web font loads silently returns
   fallback-font metrics. `await waitUntilDone()` from `loadGoogleFont`, or gate
   on `document.fonts.ready`.
2. **`border` changes layout, `outline` does not.** The official Remotion rule
   is to use `outline` for measurement-time decoration.

Also remember that overflow is **aspect-ratio dependent**: the source that
overflows at 1080x1920 is character-for-character the source that fits at
1920x1080. Check every format you ship.

Remotion's own layout rule, for reference: at 1080px wide, keep key content at
least **80px from the sides and 100px from the top and bottom**, with a headline
of at least **84px** and supporting text at least **44px**.

## Reporting the result

When you finish, state plainly:

- the command you ran,
- the final counts (`N errors, N warnings, N info`),
- any warnings you consciously accepted and why,
- and, if you looked at `--html` frames, what you actually saw.

Do not say a video is good on the strength of the render succeeding alone.
