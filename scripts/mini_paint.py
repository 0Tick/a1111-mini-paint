import html
import json
import os.path
import pathlib
import typing
import urllib.parse
from modules import script_callbacks, extensions, scripts
from  modules import generation_parameters_copypaste
from modules.shared import opts

import gradio as gr

try:
    root_path = pathlib.Path(__file__).resolve().parents[1]
except NameError:
    import inspect

    root_path = pathlib.Path(inspect.getfile(lambda: None)).resolve().parents[1]


def get_asset_url(
    file_path: pathlib.Path, append: typing.Optional[dict[str, str]] = None
) -> str:
    if append is None:
        append = {"v": str(os.path.getmtime(file_path))}
    else:
        append = append.copy()
        append["v"] = str(os.path.getmtime(file_path))
    return f"/file={file_path.absolute()}?{urllib.parse.urlencode(append)}"


def write_config_file() -> pathlib.Path:
    config_dir = root_path / "downloads"
    config_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    config_path = config_dir / "config.json"
    return config_path


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as blocks:
        create_ui()
    return [(blocks, "Mini Paint", "minipaint")]


def create_ui():
    try:
        cn_max: int = opts.data.get("control_net_unit_count", 3)
    except (ImportError, AttributeError):
        cn_max = 0
    config = {"config": get_asset_url(write_config_file()) or ""}
    html_url = get_asset_url(root_path / "miniPaint" / "index.html", config)
    with gr.Tabs(elem_id="a1111minipaint_main"):
        gr.HTML(
            f"""
            <iframe id="a1111minipaint_iframe" src="{html.escape(html_url)}" onload = "a1111minipaint.onload()"></iframe>
            """
        )
        gr.Markdown("Original: [miniPaint](https://github.com/viliusle/miniPaint)")
        gr.Text(str(cn_max), visible=False, elem_id="a1111minipaint_controlnet_max")

def main():
    js_path = root_path / "javascript" / "main.js"
    css_path = root_path /"style.css"
    original_template_response = gr.routes.templates.TemplateResponse
    head = """
    <script>
        function waitForElement(parent, selector) {
            return new Promise((resolve) => {
                const observer = new MutationObserver(() => {
                    if (!parent.querySelector(selector)) {
                        return
                    }
                    observer.disconnect()
                    resolve(undefined)
                })

                observer.observe(parent, {
                    childList: true,
                    subtree: true,
                })

                if (parent.querySelector(selector)) {
                    resolve(undefined)
                }
            })
        }
        let onTabChangedCallback
        function gradioApp() {
            const elems = document.getElementsByTagName('gradio-app')
            const gradioShadowRoot = elems.length == 0 ? null : elems[0].shadowRoot
            return gradioShadowRoot ? gradioShadowRoot : document
        }
        async function onUiLoaded(callback){
            await waitForElement(gradioApp(), '#a1111minipaint_main')
            await callback()
            await onTabChangedCallback?.()
        }
        function onUiUpdate(callback){
            onTabChangedCallback = callback
        }
    </script>
    """
    head += f"""
    <script type="module">
        document.addEventListener("DOMContentLoaded", function() {{import("{get_asset_url(js_path)}")}})
    </script>
    """
    def template_response(*args, **kwargs):
        res = original_template_response(*args, **kwargs)
        res.body = res.body.replace(b"</head>", f"{head}</head>".encode("utf8"))
        res.init_headers()
        return res
    gr.routes.templates.TemplateResponse = template_response
    with gr.Blocks(analytics_enabled=False, css=css_path.read_text()) as blocks:
        with gr.Tab(label="3D Openpose", elem_id="tab_a1111minipaint"):
            create_ui()
    blocks.launch()

try:
    from modules import script_callbacks

    script_callbacks.on_ui_tabs(on_ui_tabs)
except ImportError:
    main()