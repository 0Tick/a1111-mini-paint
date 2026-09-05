"""Forge Neo settings for the Canvas tab.

The frontend the tab mounts is a saved WebUI setting, not browser state, so it
survives a restart and can be changed from a phone that has no dev tools.
"""

from __future__ import annotations

import inspect
import os
import typing

import gradio as gr

from modules import shared

SECTION = ("minipaint_canvas", "miniPaint / Canvas")

USE_OLD_UI = "minipaint_use_old_ui"
CANVAS_HEIGHT = "minipaint_canvas_height"
DEFAULT_TOOL = "minipaint_canvas_default_tool"
MASK_COLOUR = "minipaint_canvas_mask_colour"
SNAP = "minipaint_canvas_snap"
SEND_FILL = "minipaint_canvas_send_fill"
WARN_MEGAPIXELS = "minipaint_canvas_warn_megapixels"

TOOLS = ["Crop", "Mask", "Expand"]
SNAP_CHOICES = ["Off", "8", "16", "32", "64"]
FILL_CHOICES = ["Neutral gray", "White", "Black", "Edge colour"]


def get(key: str, default: typing.Any) -> typing.Any:
    """Read a saved option without assuming this WebUI registered it."""
    try:
        value = getattr(shared.opts, key)
    except (AttributeError, KeyError):
        return default
    return default if value is None else value


# The setting is the way to switch editors - but it lives in a UI, and the
# one time it is needed most is when a UI is not co-operating. This is the
# lever that does not need one: MINIPAINT_OLD_UI=1 in the environment.
OLD_UI_ENV = "MINIPAINT_OLD_UI"
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def use_old_ui() -> bool:
    override = os.environ.get(OLD_UI_ENV, "").strip().lower()
    if override in _TRUE:
        return True
    if override in _FALSE:
        return False
    return bool(get(USE_OLD_UI, False))


def _category(name: str):
    """Only claim a settings category the host actually has.

    An option filed under a category the WebUI does not know about is not
    ignored - the Settings page looks the category up while it is being built,
    and an unknown one takes the page with it. ``None`` is the supported way
    to say "no category", so that is what an unknown name becomes.
    """
    try:
        from modules import shared_options

        mapping = getattr(getattr(shared_options, "categories", None), "mapping", None)
        if mapping is None:
            return None
        return name if name in mapping else None
    except Exception:
        return None


def _option_info(default, label, *component, **kwargs):
    """Build an OptionInfo with only the keyword arguments this build accepts.

    ``category_id`` arrived after ``section`` did, and this extension is meant
    to load on the whole Forge family rather than one commit of it. The
    component and its arguments go positionally because they have been the
    third and fourth parameters throughout.
    """
    accepted = kwargs
    try:
        parameters = inspect.signature(shared.OptionInfo.__init__).parameters
        accepted = {k: v for k, v in kwargs.items() if k in parameters}
    except (TypeError, ValueError):  # pragma: no cover - exotic builds
        pass
    return shared.OptionInfo(default, label, *component, **accepted)


def _add(key, option, info: str = "", reload_ui: bool = False) -> None:
    """Register one option, and never let it be the reason Settings breaks.

    These are conveniences; the one that matters, the frontend switch, is the
    first one registered. Losing a later one to a host that does not accept it
    is a missing checkbox, and taking the Settings page down with it would
    also take down the way back to the legacy editor.
    """
    try:
        if info and hasattr(option, "info"):
            option = option.info(info)
        if reload_ui and hasattr(option, "needs_reload_ui"):
            option = option.needs_reload_ui()
        shared.opts.add_option(key, option)
    except Exception as error:  # pragma: no cover - depends on the host
        print(f"MiniPaint: could not register the {key} setting ({error})")


def on_ui_settings() -> None:
    _add(
        USE_OLD_UI,
        _option_info(
            False,
            "Use Old UI (legacy miniPaint)",
            section=SECTION,
            category_id=_category("ui"),
        ),
        "Use the original miniPaint editor instead of the touch-first Canvas "
        "redesign. The legacy editor remains fully installed as a fallback.",
        reload_ui=True,
    )

    _add(
        CANVAS_HEIGHT,
        _option_info(
            70,
            "Canvas height (% of the browser window)",
            gr.Slider,
            {"minimum": 40, "maximum": 95, "step": 5},
            section=SECTION,
            category_id=_category("ui"),
        ),
        "How much of the window the image takes up in the new Canvas UI.",
        reload_ui=True,
    )

    _add(
        DEFAULT_TOOL,
        _option_info(
            "Crop",
            "Tool selected when the Canvas opens",
            gr.Radio,
            {"choices": TOOLS},
            section=SECTION,
            category_id=_category("ui"),
        ),
        reload_ui=True,
    )

    _add(
        MASK_COLOUR,
        _option_info(
            "#ff2f2f",
            "Mask overlay colour",
            gr.ColorPicker,
            section=SECTION,
            category_id=_category("ui"),
        ),
        "Display only. The mask itself is sent as coverage, never as this colour.",
        reload_ui=True,
    )

    _add(
        SNAP,
        _option_info(
            "8",
            "Snap expansion amounts to a multiple of",
            gr.Dropdown,
            {"choices": SNAP_CHOICES},
            section=SECTION,
        ),
        "Outpaint sides are rounded to this many pixels.",
    )

    _add(
        SEND_FILL,
        _option_info(
            "Neutral gray",
            "Fill transparent pixels with, when sending",
            gr.Dropdown,
            {"choices": FILL_CHOICES},
            section=SECTION,
        ),
        "img2img needs real pixels everywhere. Expanded area stays transparent "
        "in the editor and is filled with this on the way out.",
    )

    _add(
        WARN_MEGAPIXELS,
        _option_info(
            16,
            "Warn above this many megapixels",
            gr.Slider,
            {"minimum": 4, "maximum": 64, "step": 1},
            section=SECTION,
        ),
        "Browsers get slow and phones run out of memory well before the "
        "server does.",
    )
