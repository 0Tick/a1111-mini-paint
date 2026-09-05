# Forge Neo Canvas (formerly the [miniPaint](https://github.com/viliusle/miniPaint) extension)

A touch-first image workspace for the WebUI, built around the three things a
diffusion workflow actually needs between one generation and the next:

    CROP  ->  MASK  ->  EXPAND  ->  SEND TO IMG2IMG

The tab is still called **Mini Paint**, and the original miniPaint editor is
still shipped and still selectable. Nothing was deleted to make room for the
redesign.

## Installation

Extensions -> Available -> `Load from` -> search for `miniPaint` -> `Install`.

## Two frontends, one tab

| | |
| --- | --- |
| **Canvas** (default) | A single large `gr.ImageEditor` with ordinary Gradio controls around it. Touch-sized, theme-native, three tools. |
| **Legacy miniPaint** | The original editor in its iframe, with the bridge behaviour it has always had. |

Pick one in **Settings -> miniPaint / Canvas -> Use Old UI (legacy
miniPaint)**, then **Reload UI**. The choice is a saved WebUI setting, so it
survives a restart, and exactly one editor is ever built - there is no hidden
second canvas in the page, and no listeners from the other one.

If the new Canvas fails to build for any reason, the tab falls back to the
legacy editor by itself and puts the reason on screen; the full traceback goes
to the WebUI console. The failure is contained: Gradio abandons its build
context when a tab throws, so the fallback restores it before building - a
broken Canvas must never take the rest of the WebUI's tabs with it.

If you ever need the old editor before the UI is usable enough to reach
Settings, start the WebUI with `MINIPAINT_OLD_UI=1` in the environment. It
overrides the setting for that run.

## The Canvas

```
+---------------------------------------------------------------+
| Open  Undo  Redo        Fit  Focus        SEND TO IMG2IMG      |
+---------------------------------------------------------------+
|                                                               |
|                          IMAGE EDITOR                         |
|                                                               |
+---------------------------------------------------------------+
|          [ CROP ]        [ MASK ]        [ EXPAND ]           |
+---------------------------------------------------------------+
| tool options for the selected mode                            |
+---------------------------------------------------------------+
```

**Crop** is the default mode. Drag the editor's own crop handles for a free
crop, or pick an aspect - Free, Original, 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3
or a custom pixel size - and press **Apply Crop**. An aspect crop takes the
largest box of that shape that fits: a crop here never stretches the picture.
If the component pads its result with transparency (it has, in more than one
Gradio release), the padding is trimmed off in Python and the status line says
by how much. Cropping after masking crops both with the same coordinates.

**Mask** paints the area to regenerate. Brush, eraser and brush size are the
editor's own, driven from the panel's buttons; the size slider and the
Brush/Erase pair are Gradio controls, not painted-on fakes. **Clear Mask**
only clears the mask - it never touches the image. **Invert** flips it.
**Mask smoothing** (Off / Low / Medium / High) rounds the sawtooth a fingertip
leaves when the mask is sent; it grows and shrinks the coverage rather than
blurring and cutting it, so a thin stroke survives instead of disappearing,
and a level that would delete most of the mask is refused.

**Expand** is outpainting setup. Choose an amount, tap the sides to grow, and
the resulting dimensions appear before you commit. On Apply the image is
placed in the larger canvas and **everything new is masked automatically** -
including, if you set an overlap, a band reaching back into the original so
the model has room to blend. Sides snap to a multiple you choose, the new area
can be transparent (the default, so it is obvious what is new), edge-stretched
or a flat colour, and an expansion no browser canvas could hold is refused
rather than attempted.

**Send to img2img** is the primary action in every mode. It works out where to
go on its own:

| what the document holds | where it goes |
| --- | --- |
| an image | img2img |
| an image and a mask | img2img **Inpaint**, image and mask together |
| an expansion | img2img **Inpaint**, expanded image and its auto-mask |

The **More** panel overrides that with an explicit destination - img2img,
Inpaint, ControlNet (any unit, either tab), Extras, or back where the image
came from - and has a **Save a copy** button.

**Undo/Redo** cover the structural steps: open, receive, crop, expand, clear
mask, invert, reset. Strokes are undone by the editor's own undo, which is
where they live.

**Focus** makes the tab fill the window so a tablet feels like a dedicated
editor. Escape or the button leaves it. **Fit** re-fits the canvas after a
rotation or a resize.

Images arrive from txt2img, img2img and Extras through a **Canvas** button
added next to the other send buttons under each gallery.

## Sending is verified, not assumed

Both editors write the image into the destination and then read back the value
the WebUI will actually submit, because on Forge those are not the same thing.
`ForgeCanvas` (img2img, Inpaint, ControlNet) keeps its real value in a hidden
textbox that the visible canvas only mirrors, while Extras is an ordinary
`gr.Image`; the type of each destination is detected rather than assumed from
a WebUI or Gradio version.

A mask reaches Inpaint as the canvas *foreground*, carrying coverage in its
alpha channel - which is exactly what Forge's inpaint reads, and thresholds at
128. Image and mask are always the same size; that invariant is enforced in
Python before anything is staged.

img2img also generates from whichever of its sub-tabs the WebUI *itself* has
recorded, and it only learns about a sub-tab change through a request to the
server. A send waits for that to be acknowledged too, otherwise pressing
Generate straight after a send can render from a different slot - the classic
"my image is right there and it was ignored".

Every send is compared, pixel for pixel, against the image that was exported.
A send that does not match is retried, and one that still does not match says
so on screen instead of leaving a destination that merely looks right. The
edited document is never cleared because a transfer failed.

## The transfer log

Every send is written to a file inside this extension's folder:

```
extensions/a1111-mini-paint-NEO/logs/send-log.txt
```

Each entry records the transfer step by step with timings - what was exported,
what the destination held before and after each attempt, when the canvas
displayed it, what the WebUI ended up holding, and why an attempt was
rejected:

```
[2026-08-17 20:24:56] #img2img_image -> sent: 512x512, byte-identical
    +    0ms  exported image - 512x512, 800000 bytes, hash abc
    +  340ms  canvas displays the image
    +  900ms  verified - byte-identical, on attempt 1
```

That file is the thing to attach to a bug report. It is written by the
extension itself, so it keeps working when what failed is the WebUI's own
round trip, and it rotates once it passes 1 MB. It is created when the
extension loads, before any image is sent, and its first line says which
frontend is mounted. **If `logs/send-log.txt` does not exist after restarting
the WebUI, this version of the extension is not the one running.**

In the browser console:

```js
forgeTouchCanvas.debugReport()   // new Canvas
a1111minipaint.debugReport()     // legacy miniPaint
```

prints the Gradio version, whether `ForgeCanvas` is present, which destination
IDs were found, and - for the Canvas - whether the adapter can see the
editor's own brush controls. Please include that output in bug reports.

The legacy editor keeps its own on-screen report with a **Copy all** button
(Send -> Send log ...), for a phone or tablet with no developer console.

## Settings

**Settings -> miniPaint / Canvas**

| option | |
| --- | --- |
| Use Old UI (legacy miniPaint) | Which editor the tab builds. Needs a Reload UI. `MINIPAINT_OLD_UI=1` in the environment overrides it. |
| Canvas height | How much of the window the image takes. |
| Tool selected when the Canvas opens | Crop, Mask or Expand. |
| Mask overlay colour | Display only - the mask is sent as coverage, never as a colour. |
| Snap expansion amounts to a multiple of | Off, 8, 16, 32 or 64. |
| Fill transparent pixels with, when sending | img2img needs real pixels everywhere. |
| Warn above this many megapixels | Browsers give out well before the server does. |

## Compatibility

Works with AUTOMATIC1111 and the Forge family, including
[Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo).

Arguments that a given Gradio does not have are filtered out rather than
raised, so the Canvas builds across the 4.x line: on Gradio 4.40 there is no
native fullscreen button on `ImageEditor`, and Focus mode covers it.

Known limits, and why:

- **The mask overlay is opaque.** Gradio's `ImageEditor` draws its layers with
  no opacity control, and there is no per-layer element to style, so the
  overlay-opacity control is left out rather than faked. Toggling the mask
  layer off in the editor's own layer list shows the pixels underneath.
- **Smoothing is applied to the mask when it is sent, not to the pointer path
  as you draw.** Live smoothing means intercepting the editor's own pointer
  handling, which is exactly the kind of hook that breaks on a Gradio update -
  and masking working is more important than masking being smooth. The
  outcome, a mask without finger sawtooth, is the same.
- **Brush size and Brush/Erase drive the editor's own toolbar.** If a future
  Gradio renames those buttons the panel says so and the editor's toolbar,
  which is right there, still works.
- **A mask needs a `ForgeCanvas` destination.** On plain AUTOMATIC1111 the
  inpaint target takes an image only; the image is sent, and the status line
  says the mask stayed behind.

## Development

```
python tests/run.py
```

232 checks over the crop/mask/expand maths, the handoff staging, and both
frontends building - including that a tab which fails to build leaves the rest
of the WebUI wired up. See `tests/README.md`.

Layout:

```
scripts/mini_paint.py        entry point: registers the callbacks
forge_canvas_ext/
    settings.py              the miniPaint / Canvas settings section
    ui_router.py             picks one frontend, falls back to legacy
    transfer_log.py          the log route both editors write to
    legacy/legacy_ui.py      the miniPaint iframe
    touch/                   the Canvas: ui, imaging, outpaint, document, bridge
javascript/
    main.js                  legacy bridge, parent-frame half
    forge_touch_canvas.js    Canvas adapter - inert unless the Canvas is mounted
miniPaint/                   the legacy editor itself
```

To customise the legacy editor, `cd miniPaint && npm run build`, then reload
the UI.

## Issues, code ownership and contribution

This extension is mostly code slammed together from other extensions all being
free to use. If you want to grab parts of it, go ahead. If you find a bug,
report it in the issues section on GitHub - and please attach
`logs/send-log.txt`.
