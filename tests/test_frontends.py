"""One frontend at a time, built against the Gradio the host actually has.

Covers the compatibility requirement directly: the setting exists and is
saved, the new UI is the default, the legacy editor comes back when it is
asked for, only one of them is ever mounted, and a new UI that fails to build
still leaves a working tab behind.
"""

from harness import Results, setup_path

setup_path()

import json  # noqa: E402

import gradio as gr  # noqa: E402
from modules import shared  # noqa: E402

from PIL import Image  # noqa: E402

from forge_canvas_ext import settings, ui_router  # noqa: E402
from forge_canvas_ext.touch import imaging  # noqa: E402
from forge_canvas_ext.touch.gradio_compat import dropped  # noqa: E402


def run() -> Results:
    results = Results("frontends")

# ---- settings registration ----

    settings.on_ui_settings()
    results.check("old-ui option registered", settings.USE_OLD_UI in shared.opts.data_labels)
    results.check("old-ui default is the new UI", shared.opts.data[settings.USE_OLD_UI] is False)
    results.check("old-ui needs a reload", shared.opts.data_labels[settings.USE_OLD_UI].reload_ui is True)
    results.check("section is miniPaint / Canvas",
          shared.opts.data_labels[settings.USE_OLD_UI].section == ("minipaint_canvas", "miniPaint / Canvas"))
    results.check("every option is in that section",
          all(i.section == settings.SECTION for i in shared.opts.data_labels.values()))
    results.check("use_old_ui reads False", settings.use_old_ui() is False)
    results.check("an unknown settings category is dropped rather than claimed",
                  settings._category("no-such-category") is None)

    # One option a host will not take must not cost the Settings page - the
    # way back to the legacy editor is on it.
    original_add = shared.opts.add_option

    def refuse_one(key, option):
        if key == settings.SNAP:
            raise TypeError("this host does not want that one")
        return original_add(key, option)

    shared.opts.add_option = refuse_one
    try:
        settings.on_ui_settings()
    finally:
        shared.opts.add_option = original_add
    results.check("a refused option does not stop the others",
                  settings.WARN_MEGAPIXELS in shared.opts.data_labels)
    results.check("and the frontend switch is still registered",
                  settings.USE_OLD_UI in shared.opts.data_labels)
    results.check("get falls back", settings.get("no_such_option", "fallback") == "fallback")

    # ---- which ImageEditor arguments this Gradio actually takes ----
    wanted = dict(type="pil", image_mode="RGBA", sources=["upload", "clipboard"],
                  transforms=["crop"], layers=True, format="png",
                  show_download_button=False, show_fullscreen_button=True,
                  container=False, elem_id="x")
    ignored = dropped(gr.ImageEditor.__init__, wanted)
    print(f"  (this Gradio ignores {ignored or 'nothing'} on ImageEditor)")
    results.check("unsupported args are filtered, not raised", ignored == ["show_fullscreen_button"], str(ignored))

    # ---- the mask survives a trip through the component ----
    # This is the contract the whole editor rests on: coverage goes out as a
    # layer's alpha and has to come back as the same coverage.
    photo = Image.new("RGB", (64, 48), (200, 30, 30))
    drawn = Image.new("L", (64, 48), 0)
    drawn.paste(255, (10, 10, 30, 30))
    with gr.Blocks():
        probe = gr.ImageEditor(type="pil", image_mode="RGBA", layers=True, format="png")

    returned = probe.preprocess(
        probe.postprocess(imaging.editor_value(photo, drawn, (255, 47, 47)))
    )
    seen, seen_mask, seen_notes = imaging.read_editor(returned)
    results.check("the editor keeps the image size", seen.size == (64, 48))
    results.check("the editor keeps the pixels", seen.convert("RGB").getpixel((0, 0)) == (200, 30, 30))
    results.check("the mask comes back unchanged",
                  list(seen_mask.getdata()) == list(drawn.getdata()), str(seen_notes))
    results.check("an unmasked document has no layers",
                  probe.postprocess(imaging.editor_value(photo, None)).layers == [])
    results.check("an empty document postprocesses to nothing",
                  probe.postprocess(None) is None)

    # ---- new UI builds ----
    tabs = ui_router.on_ui_tabs()
    results.check("one tab", len(tabs) == 1)
    blocks, label, elem_id = tabs[0]
    results.check("tab label is stable", label == "Mini Paint")
    results.check("tab id is stable", elem_id == "minipaint")

    config = json.loads(json.dumps(blocks.get_config_file(), default=str))
    ids = {c["props"].get("elem_id") for c in config["components"] if c.get("props")}
    for needed in ["forge_touch_editor_root", "forge_touch_canvas", "forge_touch_send",
                   "forge_touch_payload", "forge_touch_result", "forge_touch_inbox",
                   "forge_touch_tool_crop", "forge_touch_tool_mask", "forge_touch_tool_expand",
                   "forge_touch_crop_apply", "forge_touch_expand_apply", "forge_touch_mask_clear",
                   "forge_touch_open", "forge_touch_focus", "forge_touch_status"]:
        results.check(f"component {needed}", needed in ids)

    editor = [c for c in config["components"] if c["props"].get("elem_id") == "forge_touch_canvas"]
    results.check("the canvas is an ImageEditor", editor and editor[0]["type"] == "imageeditor",
          editor[0]["type"] if editor else "missing")
    props = editor[0]["props"]
    results.check("editor returns PIL", props.get("type") == "pil")
    results.check("editor keeps PNG", props.get("format") == "png", str(props.get("format")))
    results.check("editor has layers", props.get("layers") is True)
    results.check("editor can crop", list(props.get("transforms") or []) == ["crop"])
    results.check("brush colour is fixed", (props.get("brush") or {}).get("color_mode") == "fixed")
    results.check("no webcam source", "webcam" not in (props.get("sources") or []))

    roots = [c for c in config["components"] if c["props"].get("elem_id") == "forge_touch_editor_root"]
    results.check("root carries the default tool class",
          "forge-touch-tool-crop" in (roots[0]["props"].get("elem_classes") or []),
          str(roots[0]["props"].get("elem_classes")))

    results.check("events are wired", len(config["dependencies"]) > 15, str(len(config["dependencies"])))
    targets = {d.get("targets") and d["targets"][0][1] for d in config["dependencies"]}
    results.check("an upload event exists", "upload" in targets, str(sorted(t for t in targets if t)))
    results.check("a change event exists", "change" in targets)

    # ---- legacy UI builds, and stays the same tab ----
    shared.opts.data[settings.USE_OLD_UI] = True
    legacy_tabs = ui_router.on_ui_tabs()
    lblocks, llabel, lelem = legacy_tabs[0]
    results.check("legacy keeps the tab label", llabel == "Mini Paint")
    results.check("legacy keeps the tab id", lelem == "minipaint")
    lconfig = json.loads(json.dumps(lblocks.get_config_file(), default=str))
    lids = {c["props"].get("elem_id") for c in lconfig["components"] if c.get("props")}
    results.check("legacy mounts the iframe html", "a1111minipaint_main" in lids, str(sorted(i for i in lids if i)))
    results.check("legacy passes the controlnet count", "a1111minipaint_controlnet_max" in lids)
    results.check("legacy does not mount the new canvas", "forge_touch_canvas" not in lids)
    results.check("new UI does not mount the legacy iframe", "a1111minipaint_main" not in ids)

    # ---- a failing new UI must not take the rest of the WebUI with it ----
    # Gradio nulls the build context when a Blocks body raises, so a tab that
    # throws used to orphan every component the WebUI created afterwards: the
    # page rendered and not one tab or button in it worked.
    shared.opts.data[settings.USE_OLD_UI] = False
    import forge_canvas_ext.touch.ui as touch_ui
    from gradio.context import Context, get_render_context

    print("  (the traceback below is this test breaking the new UI on purpose)")
    working = touch_ui.create_ui
    touch_ui.create_ui = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        with gr.Blocks() as host:
            before_root = Context.root_block
            before_block = get_render_context()

            fallback = ui_router.on_ui_tabs()

            results.check("the build context survives a failed tab",
                          Context.root_block is before_root)
            results.check("the render context survives a failed tab",
                          get_render_context() is before_block)
            gr.Textbox(label="after", elem_id="built_after_the_failure")
    finally:
        touch_ui.create_ui = working

    host_ids = {
        component["props"].get("elem_id")
        for component in json.loads(json.dumps(host.get_config_file(), default=str))["components"]
        if component.get("props")
    }
    results.check("components built after a failed tab are still wired up",
                  "built_after_the_failure" in host_ids)

    # A tab built inside a host hands its children to that host, so the
    # fallback's own components are looked for there.
    _fblocks, flabel, felem = fallback[0]
    results.check("a broken new UI still gives a tab", flabel == "Mini Paint" and felem == "minipaint")
    results.check("the fallback is the legacy editor", "a1111minipaint_main" in host_ids)
    results.check("the fallback says so", "forge_canvas_fallback_warning" in host_ids)
    results.check("and the new canvas is not also mounted", "forge_touch_canvas" not in host_ids)

    # ---- a Gradio without ImageEditor picks legacy instead of failing ----
    editor = gr.ImageEditor
    try:
        del gr.ImageEditor
        results.check("a missing component is named, not raised",
                      "ImageEditor" in ui_router._missing_components())
        older = ui_router.on_ui_tabs()
        older_ids = {
            component["props"].get("elem_id")
            for component in json.loads(json.dumps(older[0][0].get_config_file(), default=str))["components"]
            if component.get("props")
        }
        results.check("an older Gradio gets the legacy editor", "a1111minipaint_main" in older_ids)
        results.check("and is told why", "forge_canvas_fallback_warning" in older_ids)
    finally:
        gr.ImageEditor = editor

    # ---- the escape hatch that does not need a working UI ----
    import os

    os.environ[settings.OLD_UI_ENV] = "1"
    try:
        results.check("the environment can force the old UI", settings.use_old_ui() is True)
    finally:
        del os.environ[settings.OLD_UI_ENV]
    results.check("and stops forcing it when unset", settings.use_old_ui() is False)

    # ---- an argument this Gradio does not have costs the argument, not the tab ----
    from forge_canvas_ext.touch.gradio_compat import build

    class Fussy:
        def __init__(self, *args, **kwargs):
            if "nonsense" in kwargs:
                raise TypeError("__init__() got an unexpected keyword argument 'nonsense'")
            self.kwargs = kwargs

    made = build(Fussy, label="kept", nonsense=True)
    results.check("a refused argument is dropped by name", made.kwargs == {"label": "kept"})

    return results


if __name__ == "__main__":
    import sys

    sys.exit(0 if run().report() else 1)
