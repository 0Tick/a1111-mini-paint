# Checks

```
python tests/run.py
```

They cover the parts that decide what pixels reach img2img, and the
compatibility promise around the two frontends. Nothing here starts the WebUI:
`tests/stubs/modules` stands in for the handful of `modules.shared` and
`modules.script_callbacks` names the extension touches.

| file | what it holds the line on |
| --- | --- |
| `test_imaging.py` | crop boxes never stretch; image and mask crop with identical coordinates; smoothing rounds a jagged edge without eating a thin stroke; expansion places the original correctly, auto-masks only what is new, and refuses a canvas no browser can hold; the staged mask carries coverage in its alpha, which is what Forge's inpaint reads |
| `test_frontends.py` | the Old UI setting exists, is saved, defaults to the new editor and asks for a Reload UI; each frontend mounts alone, under the same tab name and id; a new UI that throws still leaves a working legacy tab, says why, **and leaves every component the WebUI builds after it still wired up**; a Gradio without `ImageEditor` picks legacy instead of failing; arguments this Gradio does not have are dropped rather than raised |
| `test_workflow.py` | receive, open, crop, mask, expand, undo, redo, reset and send, checked on the editor value and the status line the user actually sees, plus the files a handoff stages |

`test_frontends.py` prints one traceback on purpose - it breaks the new UI to
prove the fallback catches it.
