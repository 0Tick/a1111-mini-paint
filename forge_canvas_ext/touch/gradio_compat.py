"""Build Gradio components without pinning a Gradio version.

Forge Neo continues the Forge line on Gradio 4.40, but the family it has to
run in spans several 4.x releases - ``ImageEditor`` gained
``show_fullscreen_button`` after 4.40, for one. Rather than guessing, every
call in here is filtered against the signature the installed build actually
has, so a missing argument costs a feature instead of the tab.
"""

from __future__ import annotations

import inspect
import re
import typing

import gradio as gr

_UNEXPECTED = re.compile(r"unexpected keyword argument '([^']+)'")


def _parameters(target) -> typing.Optional[typing.Mapping[str, typing.Any]]:
    try:
        return inspect.signature(target).parameters
    except (TypeError, ValueError):  # pragma: no cover - C-implemented callables
        return None


def supported(target, kwargs: dict) -> dict:
    """Only the keyword arguments ``target`` will accept."""
    parameters = _parameters(target)
    if parameters is None:
        return dict(kwargs)
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return dict(kwargs)
    return {key: value for key, value in kwargs.items() if key in parameters}


def dropped(target, kwargs: dict) -> list:
    """Which arguments this build would ignore - worth saying out loud once."""
    kept = supported(target, kwargs)
    return sorted(set(kwargs) - set(kept))


def build(component, **kwargs):
    """Instantiate a component with whatever of ``kwargs`` it understands.

    Reading the signature is the first line of defence and usually the only
    one needed. It is not enough on its own: the WebUI patches Gradio's
    component constructors, and a wrapper that takes ``**kwargs`` reports
    every argument as acceptable right up until the real constructor refuses
    it. So an argument the host turns out not to have is dropped on the way
    back out too, by name, rather than costing the whole tab.
    """
    attempt = supported(component.__init__, kwargs)
    while True:
        try:
            return component(**attempt)
        except TypeError as error:
            match = _UNEXPECTED.search(str(error))
            name = match.group(1) if match else None
            if name is None or name not in attempt:
                raise
            attempt.pop(name)


def has(name: str) -> bool:
    """Is this Gradio build carrying the component named ``name``?"""
    return getattr(gr, name, None) is not None
