/**
 * Touch Canvas adapter, parent-frame side.
 *
 * The redesigned Canvas is built from ordinary Gradio components, so almost
 * all of it needs no JavaScript at all. This file covers the four things the
 * host component cannot do for itself:
 *
 *   1. delivering a finished image (and mask) into img2img / Inpaint /
 *      ControlNet / Extras, and proving it landed,
 *   2. picking an image up from a txt2img / img2img / Extras gallery,
 *   3. switching tool modes, focus mode and the editor's own brush without a
 *      server round trip,
 *   4. keeping a drawing gesture on the canvas instead of scrolling the page.
 *
 * It does nothing at all unless the redesigned tab is actually mounted. When
 * the "Use Old UI (legacy miniPaint)" setting is on, #forge_touch_editor_root
 * does not exist, no listener is attached and no style is touched - which is
 * what keeps the fallback a fallback.
 *
 * The transfer half is a parent-frame port of the bridge that lives inside the
 * legacy editor's bundle (miniPaint/src/js/libs/webui-host.js). It is a
 * deliberate copy rather than a shared module: the legacy code is compiled
 * into an iframe bundle and cannot be imported from here, and the fallback
 * must not be destabilised by changes made for the redesign.
 */
window.forgeTouchCanvas = window.forgeTouchCanvas || {};

(function () {
    "use strict";

    const ROOT = "#forge_touch_editor_root";
    const CANVAS = "#forge_touch_canvas";
    const PREFIX = "ForgeCanvas:";

    const TRANSFER_TIMEOUT_MS = 10000;
    const POLL_MS = 300;

    /* ---------------------------------------------------------------- */
    /* DOM basics                                                        */
    /* ---------------------------------------------------------------- */

    function root() {
        try {
            if (typeof gradioApp === "function") {
                return gradioApp() || document;
            }
        } catch (e) {
            /* fall through */
        }
        return document;
    }

    function q(selector) {
        try {
            return root().querySelector(selector) || null;
        } catch (e) {
            return null;
        }
    }

    function info(message) {
        console.log(`${PREFIX} ${message}`);
    }

    function warn(message, error) {
        if (error !== undefined) {
            console.warn(`${PREFIX} ${message}`, error);
        } else {
            console.warn(`${PREFIX} ${message}`);
        }
    }

    function pause(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function waitForSelector(selector, timeoutMs) {
        const existing = q(selector);
        if (existing) {
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const target = root();
            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`${PREFIX} ${selector} was not found within ${timeoutMs}ms`));
            }, timeoutMs);
            const observer = new MutationObserver(() => {
                const element = q(selector);
                if (element) {
                    clearTimeout(timer);
                    observer.disconnect();
                    resolve(element);
                }
            });
            observer.observe(target, { childList: true, subtree: true });
        });
    }

    /**
     * Poll a predicate until it holds. Everything waited on here is host state
     * we do not own - Gradio's uploader, ForgeCanvas' own 100ms textarea poll -
     * so it is bounded by a deadline rather than trusting a single event.
     * `stableMs` additionally requires it to keep holding, because a value a
     * late reply can still overwrite is only worth trusting once it stops
     * moving.
     */
    function waitUntil(predicate, options) {
        options = options || {};
        const timeoutMs = options.timeoutMs || TRANSFER_TIMEOUT_MS;
        const intervalMs = options.intervalMs || 50;
        const stableMs = options.stableMs || 0;
        const description = options.description || "condition";

        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            let holdingSince = null;

            (function poll() {
                let holds = false;
                try {
                    holds = !!predicate();
                } catch (e) {
                    holds = false;
                }

                if (holds) {
                    if (!stableMs) {
                        resolve(true);
                        return;
                    }
                    holdingSince = holdingSince === null ? Date.now() : holdingSince;
                    if (Date.now() - holdingSince >= stableMs) {
                        resolve(true);
                        return;
                    }
                } else {
                    holdingSince = null;
                }

                if (Date.now() > deadline) {
                    reject(new Error(`${PREFIX} timed out waiting for ${description}`));
                    return;
                }
                setTimeout(poll, intervalMs);
            })();
        });
    }

    /**
     * Write through the prototype setter so frameworks that shadow `value`
     * (Svelte does) actually observe the write.
     */
    function setNativeValue(element, value) {
        const property = element.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(property.prototype, "value");
            if (descriptor && descriptor.set) {
                descriptor.set.call(element, value);
                return true;
            }
        } catch (e) {
            /* fall through */
        }
        element.value = value;
        return false;
    }

    function fire(element, type, init) {
        element.dispatchEvent(new Event(type, init || { bubbles: true }));
    }

    function isPngDataUrl(value) {
        return typeof value === "string" && value.indexOf("data:image/png;base64,") === 0;
    }

    /* ---------------------------------------------------------------- */
    /* Reading what the WebUI will actually submit                       */
    /* ---------------------------------------------------------------- */

    function gradioComponentValue(elemId, className) {
        try {
            const components = window.gradio_config && window.gradio_config.components;
            if (!Array.isArray(components)) {
                return { readable: false, reason: "gradio_config.components not available" };
            }
            for (const component of components) {
                const props = component.props || {};
                if (props.elem_id !== elemId) {
                    continue;
                }
                if (className && (props.elem_classes || []).indexOf(className) === -1) {
                    continue;
                }
                return { readable: true, value: props.value, componentId: component.id };
            }
            return { readable: false, reason: `no component with elem_id ${elemId}` };
        } catch (e) {
            return { readable: false, reason: "gradio_config could not be read" };
        }
    }

    /* ---------------------------------------------------------------- */
    /* Comparing images                                                  */
    /* ---------------------------------------------------------------- */

    const SIGNATURE_SIZE = 32;
    const SIGNATURE_TOLERANCE = 4;

    function stringHash(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16);
    }

    /** Decode an image and describe it well enough to recognise it again. */
    function imageSignature(dataUrl) {
        return new Promise((resolve, reject) => {
            if (typeof dataUrl !== "string" || !dataUrl) {
                reject(new Error(`${PREFIX} there is no image to describe`));
                return;
            }
            const image = new Image();
            image.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = SIGNATURE_SIZE;
                canvas.height = SIGNATURE_SIZE;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                context.clearRect(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
                context.drawImage(image, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
                const pixels = context.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data;

                let opaque = 0;
                for (let i = 3; i < pixels.length; i += 4) {
                    if (pixels[i] > 0) {
                        opaque++;
                    }
                }

                resolve({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    length: dataUrl.length,
                    hash: stringHash(dataUrl),
                    pixels,
                    coverage: Math.round((opaque / (SIGNATURE_SIZE * SIGNATURE_SIZE)) * 100),
                });
            };
            image.onerror = () => reject(new Error(`${PREFIX} the image could not be decoded`));
            image.src = dataUrl;
        });
    }

    /**
     * Colours are weighted by their alpha because a canvas round trip discards
     * whatever was under a fully transparent pixel - without that, a mask (which
     * is almost entirely transparent) always compares as "different".
     */
    function compareSignatures(sent, held) {
        if (sent.width !== held.width || sent.height !== held.height) {
            return {
                same: false,
                reason: `it is ${held.width}x${held.height}, not ${sent.width}x${sent.height}`,
            };
        }
        let total = 0;
        for (let i = 0; i < sent.pixels.length; i += 4) {
            const sentAlpha = sent.pixels[i + 3];
            const heldAlpha = held.pixels[i + 3];
            for (let channel = 0; channel < 3; channel++) {
                total += Math.abs(
                    (sent.pixels[i + channel] * sentAlpha) / 255 -
                        (held.pixels[i + channel] * heldAlpha) / 255
                );
            }
            total += Math.abs(sentAlpha - heldAlpha);
        }
        const difference = total / sent.pixels.length;
        return {
            same: difference <= SIGNATURE_TOLERANCE,
            difference: Math.round(difference * 100) / 100,
            byteIdentical: sent.length === held.length && sent.hash === held.hash,
            reason:
                difference <= SIGNATURE_TOLERANCE
                    ? null
                    : `its pixels differ from the sent image by ${Math.round(difference)}/255 on average`,
        };
    }

    /* ---------------------------------------------------------------- */
    /* Bytes                                                             */
    /* ---------------------------------------------------------------- */

    function bytesToBase64(bytes) {
        // One call per megabyte or so: String.fromCharCode.apply blows the
        // argument limit on a whole image.
        const chunk = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    /**
     * Fetch one of the PNGs the extension staged for this send.
     *
     * The prefix is asserted rather than sniffed: these are files this
     * extension wrote as PNG a moment ago, and ForgeCanvas drops anything that
     * is not a PNG data URL without saying so.
     */
    function hostUrl(path) {
        try {
            return new URL(String(path).replace(/^\//, ""), document.baseURI).href;
        } catch (e) {
            return path;
        }
    }

    async function fetchDataUrl(url) {
        const response = await fetch(hostUrl(url), { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${PREFIX} could not read the staged image (${response.status})`);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        return `data:image/png;base64,${bytesToBase64(buffer)}`;
    }

    function dataUrlToBytes(dataUrl) {
        const parts = dataUrl.split(",");
        const mime = parts[0].match(/:(.*?);/)[1];
        const binary = atob(parts[1]);
        let length = binary.length;
        const bytes = new Uint8Array(length);
        while (length--) {
            bytes[length] = binary.charCodeAt(length);
        }
        return { bytes, mime };
    }

    /* ---------------------------------------------------------------- */
    /* Transfer records and the log file                                 */
    /* ---------------------------------------------------------------- */

    const records = [];

    function startRecord(destination) {
        const record = {
            destination,
            startedAt: new Date().toISOString(),
            steps: [],
            outcome: "in progress",
        };
        const started = Date.now();
        record.step = (what, detail) => {
            record.steps.push(
                `+${String(Date.now() - started).padStart(5)}ms  ${what}${detail ? ` - ${detail}` : ""}`
            );
            return record;
        };
        records.unshift(record);
        records.length = Math.min(records.length, 10);
        return record;
    }

    function logEndpoints() {
        const candidates = [];
        try {
            candidates.push(new URL("minipaint/log", document.baseURI).href);
        } catch (e) {
            /* fall back to the root-relative address */
        }
        candidates.push("/minipaint/log");
        return candidates.filter((value, index) => candidates.indexOf(value) === index);
    }

    let logEndpoint = null;

    async function writeSendLog(record) {
        if (!record) {
            return;
        }
        const body = JSON.stringify({
            destination: record.destination,
            startedAt: record.startedAt,
            outcome: record.outcome,
            steps: record.steps,
        });
        for (const address of logEndpoint ? [logEndpoint] : logEndpoints()) {
            try {
                const response = await fetch(address, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                if (!response.ok) {
                    continue;
                }
                const written = await response.json();
                if (written && written.ok) {
                    logEndpoint = address;
                    return;
                }
            } catch (e) {
                /* try the next address */
            }
        }
        warn("the transfer could not be written to logs/send-log.txt");
    }

    /* ---------------------------------------------------------------- */
    /* Destinations                                                      */
    /* ---------------------------------------------------------------- */

    function classifyTarget(wrapper) {
        if (!wrapper) {
            return "missing";
        }
        if (wrapper.querySelector("input.forge-file-upload")) {
            return "forge-canvas";
        }
        if (wrapper.querySelector("input[type='file']")) {
            return "gradio-image";
        }
        return "unsupported";
    }

    function forgeCanvasUuid(wrapper) {
        const input = wrapper && wrapper.querySelector("input.forge-file-upload");
        const fromInput = input && /^imageInput_(.+)$/.exec(input.id || "");
        if (fromInput) {
            return fromInput[1];
        }
        const container = wrapper && wrapper.querySelector(".forge-container");
        const fromContainer = container && /^container_(.+)$/.exec(container.id || "");
        return fromContainer ? fromContainer[1] : null;
    }

    /**
     * Both of a ForgeCanvas' hidden Textboxes carry the canvas uuid as their
     * elem_id and are told apart by class, so this cannot go through
     * getElementById.
     */
    function forgeLogicalTextarea(uuid, className) {
        const scope = root();
        try {
            const direct = scope.querySelector(`#${uuid}.${className} textarea`);
            if (direct) {
                return direct;
            }
        } catch (e) {
            /* fall through to the scan */
        }
        for (const block of scope.querySelectorAll(`.${className}`)) {
            if (block.id === uuid) {
                const textarea = block.querySelector("textarea");
                if (textarea) {
                    return textarea;
                }
            }
        }
        return null;
    }

    async function forgeCommittedValue(uuid, textarea) {
        const value = (textarea && textarea.value) || "";
        const probe = gradioComponentValue(uuid, "logical_image_background");
        if (!probe.readable) {
            return { value, source: "canvas textbox", mirror: "not exposed by this Gradio build" };
        }
        const read = () => gradioComponentValue(uuid, "logical_image_background").value;
        let mirror = "agrees with the textbox";
        try {
            await waitUntil(() => read() === (textarea ? textarea.value : ""), {
                timeoutMs: 2000,
                intervalMs: 25,
                description: "Gradio's value to catch up with the canvas textbox",
            });
        } catch (e) {
            const held = read();
            mirror = `DISAGREES: gradio holds ${typeof held === "string" ? `${held.length} bytes` : typeof held}`;
        }
        return { value, source: "canvas textbox", mirror };
    }

    function transferBudget(dataUrl) {
        const megabytes = (dataUrl ? dataUrl.length : 0) / 1048576;
        return {
            megabytes: Math.round(megabytes * 100) / 100,
            displayMs: Math.min(120000, Math.round(5000 + megabytes * 2500)),
            settleMs: Math.min(30000, Math.round(2000 + megabytes * 500)),
        };
    }

    async function describeValue(value) {
        if (!value) {
            return "empty";
        }
        if (!isPngDataUrl(value)) {
            return `${value.length} bytes that are not a PNG data URL`;
        }
        try {
            const signature = await imageSignature(value);
            return `${signature.width}x${signature.height}, ${signature.length} bytes, hash ${signature.hash}`;
        } catch (e) {
            return `${value.length} bytes that do not decode`;
        }
    }

    /**
     * Commit an image to a ForgeCanvas, then confirm that what img2img will
     * submit really is the image we sent, retrying the write before giving up.
     *
     * The value that matters is the hidden Textbox, not the canvas on screen:
     * those are not the same thing, and only the first one is submitted.
     */
    async function setForgeCanvasImage(wrapper, dataUrl, options) {
        options = options || {};
        const label = `#${(wrapper && wrapper.id) || "(no id)"}`;
        const attempts = options.attempts || 3;
        const record = options.record;

        if (!isPngDataUrl(dataUrl)) {
            throw new Error(`${PREFIX} ${label}: ForgeCanvas only accepts PNG data URLs`);
        }

        const uuid = forgeCanvasUuid(wrapper);
        if (!uuid) {
            throw new Error(`${PREFIX} ${label}: could not read the ForgeCanvas uuid`);
        }
        const background = forgeLogicalTextarea(uuid, "logical_image_background");
        if (!background) {
            throw new Error(`${PREFIX} ${label}: ForgeCanvas ${uuid} has no background textbox`);
        }
        const foreground = forgeLogicalTextarea(uuid, "logical_image_foreground");
        const visible = wrapper.querySelector("img.forge-image");
        const sent = await imageSignature(dataUrl);
        const budget = transferBudget(dataUrl);

        record.step(
            "exported image",
            `${sent.width}x${sent.height}, ${sent.length} bytes, hash ${sent.hash}, ` +
                `canvas ${uuid}, allowing ${budget.displayMs}ms for ${budget.megabytes}MB`
        );

        let failure = "the transfer was never attempted";

        for (let attempt = 1; attempt <= attempts; attempt++) {
            record.step(`attempt ${attempt}`, `textbox currently ${await describeValue(background.value)}`);

            // A scribble left over from the previous image survives an image of
            // identical dimensions and would be submitted along with ours. The
            // mask this send carries, if any, is written after the background
            // has settled.
            if (foreground && foreground.value) {
                setNativeValue(foreground, "");
                fire(foreground, "input");
                record.step("cleared the foreground");
            }

            if (background.value !== dataUrl) {
                setNativeValue(background, dataUrl);
                fire(background, "input");
                record.step("wrote the image into the textbox", `it now holds ${background.value.length} bytes`);
            } else {
                record.step("textbox already holds the image", "waiting for the canvas rather than rewriting");
            }

            if (visible) {
                try {
                    await waitUntil(
                        () => visible.src === dataUrl && visible.complete && visible.naturalWidth > 0,
                        { timeoutMs: budget.displayMs, description: `${label} to display the sent image` }
                    );
                    record.step("canvas displays the image");
                } catch (e) {
                    record.step("canvas never displayed the image", `waited ${budget.displayMs}ms`);
                }
            }

            // The canvas rewrites the textbox after it loads; judging before
            // that has stopped moving reads a value still on its way.
            try {
                let previous = background.value;
                await waitUntil(
                    () => {
                        const settled = background.value === previous;
                        previous = background.value;
                        return settled;
                    },
                    {
                        timeoutMs: budget.settleMs,
                        intervalMs: 100,
                        stableMs: 400,
                        description: `${label} to settle`,
                    }
                );
            } catch (e) {
                record.step("the textbox never stopped changing", `waited ${budget.settleMs}ms`);
            }

            if (!background.isConnected) {
                record.outcome = "failed: the component was replaced mid-transfer";
                throw new Error(`${PREFIX} ${label}: the canvas was replaced during the transfer`);
            }

            const committed = await forgeCommittedValue(uuid, background);
            record.step(
                "read back what the WebUI will submit",
                `${await describeValue(committed.value)} (from the ${committed.source}; gradio copy ${committed.mirror})`
            );

            if (!committed.value) {
                failure = "the WebUI holds no image for it";
            } else if (!isPngDataUrl(committed.value)) {
                failure = "the WebUI holds something that is not a PNG";
            } else {
                let held = null;
                try {
                    held = await imageSignature(committed.value);
                } catch (e) {
                    failure = `the WebUI holds ${committed.value.length} bytes that do not decode as an image`;
                }
                if (held) {
                    const comparison = compareSignatures(sent, held);
                    if (comparison.same) {
                        const how = comparison.byteIdentical
                            ? "byte-identical"
                            : `re-encoded by the host, pixel difference ${comparison.difference}/255`;
                        record.step("verified", `${how}, on attempt ${attempt}`);
                        return {
                            kind: "forge-canvas",
                            uuid,
                            width: sent.width,
                            height: sent.height,
                            how,
                            stillHolds: async () => {
                                const now = await forgeCommittedValue(uuid, background);
                                if (!now.value) {
                                    return "the WebUI now holds no image";
                                }
                                try {
                                    const again = await imageSignature(now.value);
                                    const check = compareSignatures(sent, again);
                                    return check.same ? null : `the WebUI now holds a different image: ${check.reason}`;
                                } catch (e) {
                                    return "the WebUI now holds something that does not decode";
                                }
                            },
                        };
                    }
                    failure = `the WebUI holds a different image: ${comparison.reason}`;
                }
            }

            if (attempt < attempts) {
                warn(`${label}: ${failure} - retrying (attempt ${attempt + 1} of ${attempts})`);
                const container = wrapper.querySelector(".forge-container");
                if (typeof options.reveal === "function" && container && !container.clientWidth) {
                    options.reveal();
                    record.step("revealed the destination", "its canvas had no size to draw into");
                    await pause(400);
                }
                // Only blank it when the textbox already holds exactly what we
                // are about to write: the canvas ignores a write that changes
                // nothing, but blanking otherwise throws away a load in flight.
                if (background.value === dataUrl) {
                    setNativeValue(background, "");
                    fire(background, "input");
                    record.step("blanked the textbox", "so the canvas reacts to the next write");
                    await pause(250);
                }
            }
        }

        record.outcome = `failed: ${failure}`;
        throw new Error(`${PREFIX} ${label}: sent the image ${attempts} times and ${failure}`);
    }

    /**
     * Write the mask into the canvas' foreground.
     *
     * Forge's inpaint reads the foreground's *alpha* and thresholds it at 128,
     * so the mask travels as coverage and the colour underneath it never
     * matters. Verified the same way as the image: by reading back the value
     * the WebUI would submit.
     */
    async function setForgeCanvasForeground(uuid, dataUrl, record) {
        const foreground = forgeLogicalTextarea(uuid, "logical_image_foreground");
        if (!foreground) {
            record.step("no foreground textbox", "the mask could not be attached to this canvas");
            return { attached: false, reason: "this canvas has no foreground layer" };
        }

        const sent = await imageSignature(dataUrl);
        const budget = transferBudget(dataUrl);
        record.step("mask", `${sent.width}x${sent.height}, ${sent.coverage}% covered`);

        for (let attempt = 1; attempt <= 2; attempt++) {
            setNativeValue(foreground, dataUrl);
            fire(foreground, "input");

            try {
                let previous = foreground.value;
                await waitUntil(
                    () => {
                        const settled = foreground.value === previous;
                        previous = foreground.value;
                        return settled;
                    },
                    {
                        timeoutMs: budget.settleMs,
                        intervalMs: 100,
                        stableMs: 400,
                        description: "the mask textbox to settle",
                    }
                );
            } catch (e) {
                record.step("the mask textbox never stopped changing");
            }

            const held = foreground.value;
            if (isPngDataUrl(held)) {
                try {
                    const signature = await imageSignature(held);
                    const comparison = compareSignatures(sent, signature);
                    if (comparison.same) {
                        record.step("mask verified", `on attempt ${attempt}`);
                        return { attached: true };
                    }
                    record.step("the canvas holds a different mask", comparison.reason || "");
                } catch (e) {
                    record.step("the mask value does not decode");
                }
            } else {
                record.step("the mask textbox holds no PNG", `${(held || "").length} bytes`);
            }
        }

        return { attached: false, reason: "the canvas would not keep the mask" };
    }

    /* ----- ordinary gr.Image ----------------------------------------- */

    function imagePreview(wrapper) {
        if (!wrapper) {
            return null;
        }
        const candidates = wrapper.querySelectorAll(
            "div[data-testid='image'] img, .image-container img, .image-frame img, img"
        );
        for (const candidate of candidates) {
            const src = candidate.getAttribute("src") || "";
            if (!src || src.indexOf("data:image/svg+xml") === 0 || candidate.closest("button")) {
                continue;
            }
            return candidate;
        }
        return null;
    }

    function clearButtonIn(wrapper) {
        return (
            wrapper.querySelector("button[aria-label='Remove Image']") ||
            wrapper.querySelector("button[aria-label='Clear']") ||
            wrapper.querySelector("button[title='Remove Image']") ||
            wrapper.querySelector("button[title='Clear']") ||
            null
        );
    }

    /**
     * Commit an image to an ordinary gr.Image and wait for it to load.
     *
     * `resolve` re-reads the wrapper because clearing a Gradio image can
     * replace the component's DOM, so neither the wrapper nor its file input
     * may be held across that step.
     */
    async function setGradioImageFile(resolve, dataUrl, filename, record) {
        const wrapper = resolve();
        const label = `#${(wrapper && wrapper.id) || "(no id)"}`;
        const previousSource = (imagePreview(wrapper) || {}).src || "";
        let cleared = !previousSource;

        const clearButton = wrapper && clearButtonIn(wrapper);
        if (clearButton) {
            clearButton.click();
            try {
                await waitUntil(() => ((imagePreview(resolve()) || {}).src || "") !== previousSource, {
                    timeoutMs: 1000,
                    intervalMs: 25,
                    description: `${label} to clear`,
                });
                cleared = true;
            } catch (e) {
                /* the load check below then insists on a new source */
            }
        }

        const current = resolve();
        if (!current) {
            throw new Error(`${PREFIX} ${label} disappeared while it was being cleared`);
        }
        const input = current.querySelector("input[type='file']");
        if (!input) {
            throw new Error(`${PREFIX} ${label}: no upload input after clearing`);
        }

        const { bytes, mime } = dataUrlToBytes(dataUrl);
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], filename, { type: mime }));
        input.value = "";
        input.files = transfer.files;
        fire(input, "input", { bubbles: true, composed: true });
        fire(input, "change", { bubbles: true, composed: true });
        record.step("handed the file to the upload input", `${dataUrl.length} bytes`);

        // Gradio 4 uploads through the server before it has a value at all, so
        // the only honest completion signal is a preview that finished loading
        // and cannot be the one that was there before.
        await waitUntil(
            () => {
                const preview = imagePreview(resolve());
                return (
                    !!preview &&
                    (cleared || preview.src !== previousSource) &&
                    preview.complete &&
                    preview.naturalWidth > 0
                );
            },
            { description: `${label} to load the sent image` }
        );

        record.step("verified", "against the component's preview");
        return { kind: "gradio-image", how: "uploaded", stillHolds: async () => null };
    }

    async function setImageOnTarget(selector, dataUrl, options) {
        options = options || {};
        const resolve = () => q(selector);
        const wrapper = resolve();
        const kind = classifyTarget(wrapper);

        if (kind === "missing") {
            throw new Error(`${PREFIX} destination ${selector} was not found in the WebUI`);
        }
        if (kind === "unsupported") {
            throw new Error(`${PREFIX} ${selector} exists but no upload input was found`);
        }
        if (kind === "forge-canvas") {
            return setForgeCanvasImage(wrapper, dataUrl, options);
        }
        return setGradioImageFile(resolve, dataUrl, options.filename || "canvas.png", options.record);
    }

    /* ---------------------------------------------------------------- */
    /* Tabs and img2img sub-tabs                                         */
    /* ---------------------------------------------------------------- */

    const IMG2IMG_MODES = {
        img2img_img2img: { index: 0, button: "#img2img_img2img_tab-button", label: "img2img" },
        img2img_inpaint: { index: 2, button: "#img2img_inpaint_tab-button", label: "inpaint" },
    };

    /**
     * img2img does not read the canvas the user is looking at: it reads the
     * slot named by a hidden Number inside #mode_img2img, and that Number is
     * only updated by a server round trip when a sub-tab is selected. Clicking
     * the tab and generating straight away therefore generates from the
     * previous slot - the image is visibly there and still not used.
     */
    function img2imgModeInput() {
        const container = q("#mode_img2img");
        if (!container) {
            return null;
        }
        for (const input of container.querySelectorAll("input[type='number']")) {
            const item = input.closest(".tabitem");
            if (!item || !container.contains(item)) {
                return input;
            }
        }
        return null;
    }

    async function selectImg2ImgMode(destination) {
        const mode = IMG2IMG_MODES[destination];
        if (!mode) {
            return { applied: false, reason: "destination has no img2img sub-tab" };
        }
        const container = q("#mode_img2img");
        if (!container) {
            return { applied: false, reason: "#mode_img2img not found" };
        }
        const button =
            q(mode.button) || container.querySelectorAll(".tab-nav button")[mode.index] || null;
        if (!button) {
            return { applied: false, reason: `sub-tab button for ${mode.label} not found` };
        }

        const alreadySelected = button.classList.contains("selected");
        if (!alreadySelected) {
            button.click();
        }

        const input = img2imgModeInput();
        if (!input) {
            return { applied: true, verified: false, reason: "no mode value exposed in the DOM" };
        }

        const settled = () => Number(input.value) === mode.index;
        const half = Math.round(TRANSFER_TIMEOUT_MS / 2);
        const waitForMode = () =>
            waitUntil(settled, {
                timeoutMs: half,
                // Replies to earlier tab clicks can still be in flight and
                // would overwrite a value accepted a moment too early.
                stableMs: 400,
                description: `the WebUI to switch img2img to ${mode.label}`,
            });

        try {
            await waitForMode();
        } catch (first) {
            // Two tab clicks in one frame are collapsed by the front end into
            // no net change, so no select fires and the value stays stale for
            // good. Re-select by way of a sibling tab, letting each click land.
            const buttons = container.querySelectorAll(".tab-nav button");
            const sibling = buttons[mode.index === 0 ? 1 : 0];
            try {
                if (sibling && sibling !== button) {
                    sibling.click();
                    await waitUntil(() => sibling.classList.contains("selected"), {
                        timeoutMs: 1000,
                        intervalMs: 25,
                        description: "the img2img tab strip to settle",
                    });
                }
                button.click();
                await waitForMode();
            } catch (second) {
                throw new Error(
                    `${PREFIX} the image was sent, but the WebUI still reports img2img mode ` +
                        `${input.value} instead of ${mode.index} (${mode.label}); generating now ` +
                        `would use a different image. Click the ${mode.label} tab once to sync it.`
                );
            }
        }
        return { applied: true, verified: true, index: mode.index };
    }

    function callHost(name) {
        try {
            if (typeof window[name] === "function") {
                window[name]();
                return true;
            }
        } catch (e) {
            warn(`failed calling ${name}()`, e);
        }
        return false;
    }

    const SWITCHERS = {
        img2img: () => callHost("switch_to_img2img"),
        inpaint: () => callHost("switch_to_inpaint"),
        extras: () => callHost("switch_to_extras"),
        txt2img: () => callHost("switch_to_txt2img"),
    };

    function switchTo(name) {
        const switcher = SWITCHERS[name];
        return switcher ? switcher() : false;
    }

    /** Gradio 4 derives the tab button id from the TabItem elem_id. */
    function switchToCanvas() {
        const byId = q("#tab_minipaint-button");
        if (byId) {
            byId.click();
            return true;
        }
        const byAria = q('#tabs button[aria-controls="tab_minipaint"]');
        if (byAria) {
            byAria.click();
            return true;
        }
        return false;
    }

    /* ---------------------------------------------------------------- */
    /* ControlNet                                                        */
    /* ---------------------------------------------------------------- */

    function controlnetSelector(tab, index) {
        return `#${tab}_controlnet_ControlNet-${index}_input_image`;
    }

    function openControlnetAccordion(tab) {
        const accordion = q(`#${tab}_controlnet`);
        const label = accordion && accordion.querySelector(".label-wrap");
        if (label && !label.classList.contains("open")) {
            label.click();
        }
        const unit = q(`#${tab}_controlnet_ControlNet-0_controlnet_unit_enabled_checkbox`);
        if (unit) {
            unit.scrollIntoView({ block: "nearest" });
        }
    }

    async function resolveControlnetTarget(tab, index) {
        const selector = controlnetSelector(tab, index);
        if (q(selector)) {
            return selector;
        }
        switchTo(tab);
        openControlnetAccordion(tab);
        await waitForSelector(selector, TRANSFER_TIMEOUT_MS);
        return selector;
    }

    /* ---------------------------------------------------------------- */
    /* The send itself                                                   */
    /* ---------------------------------------------------------------- */

    function reportResult(payload, result) {
        const textarea = q("#forge_touch_result textarea");
        if (!textarea) {
            return;
        }
        setNativeValue(
            textarea,
            JSON.stringify(Object.assign({ token: payload.token, label: payload.label }, result))
        );
        fire(textarea, "input");
    }

    let sending = false;

    async function send(payload) {
        if (sending) {
            return;
        }
        sending = true;
        const record = startRecord(payload.label);
        try {
            const imageDataUrl = await fetchDataUrl(payload.image);
            const maskDataUrl = payload.mask ? await fetchDataUrl(payload.mask) : null;
            record.step("read the staged image", `${payload.width}x${payload.height}`);

            let selector = payload.selector;
            if (payload.controlnet) {
                selector = await resolveControlnetTarget(
                    payload.controlnet.tab,
                    payload.controlnet.index
                );
            } else if (!q(selector)) {
                // A destination in a tab that has never been opened is not in
                // the page yet, and a canvas with no size cannot draw itself.
                switchTo(payload.switch);
                await waitForSelector(selector, TRANSFER_TIMEOUT_MS);
                record.step("opened the destination", `${selector} was not mounted yet`);
            }

            const outcome = await setImageOnTarget(selector, imageDataUrl, {
                record,
                filename: payload.filename,
                reveal: () => switchTo(payload.switch),
            });

            let detail = `${payload.width}x${payload.height}, ${outcome.how}`;
            let maskNote = "";
            if (maskDataUrl && outcome.kind === "forge-canvas") {
                const mask = await setForgeCanvasForeground(outcome.uuid, maskDataUrl, record);
                maskNote = mask.attached ? " with its mask" : ` - but ${mask.reason}`;
            } else if (maskDataUrl) {
                maskNote = " - this destination takes an image only, so the mask stayed here";
                record.step("mask not sent", "the destination is not a ForgeCanvas");
            }

            // Done while the user is still on the Canvas tab, so the round trip
            // is over before they can reach Generate.
            const mode = await selectImg2ImgMode(payload.destination);
            if (mode.applied) {
                record.step("img2img sub-tab", mode.verified ? "acknowledged by the WebUI" : mode.reason);
            }

            const drifted = await outcome.stillHolds();
            if (drifted) {
                throw new Error(`${PREFIX} ${drifted}`);
            }

            switchTo(payload.switch);
            record.outcome = `sent: ${detail}${maskNote}`;
            info(`sent to ${payload.label}: ${detail}${maskNote}`);
            reportResult(payload, { ok: true, detail: detail + maskNote });
        } catch (error) {
            const message = (error && error.message) || String(error);
            record.outcome = `failed: ${message}`;
            console.error(error);
            reportResult(payload, {
                ok: false,
                message: message.replace(`${PREFIX} `, ""),
                detail: "The full step-by-step report is in logs/send-log.txt and the browser console.",
            });
        } finally {
            sending = false;
            writeSendLog(record);
        }
    }

    /* ---------------------------------------------------------------- */
    /* Receiving an image from a gallery                                 */
    /* ---------------------------------------------------------------- */

    const RECEIVE_TARGETS = [
        ["image_buttons_txt2img", "txt2img_gallery"],
        ["image_buttons_img2img", "img2img_gallery"],
        ["image_buttons_extras", "extras_gallery"],
    ];

    function selectedGalleryImage(gallery) {
        if (!gallery) {
            return null;
        }
        return (
            gallery.querySelector(".preview img") ||
            gallery.querySelector(".thumbnail-item.selected img") ||
            gallery.querySelector("img") ||
            null
        );
    }

    async function receiveFromGallery(gallery) {
        const image = selectedGalleryImage(gallery);
        if (!image || !image.src) {
            warn("there is no image selected in that gallery");
            return;
        }
        switchToCanvas();

        const record = startRecord("Canvas inbox");
        try {
            const response = await fetch(image.src, { cache: "force-cache" });
            const blob = await response.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const dataUrl = `data:${blob.type || "image/png"};base64,${bytesToBase64(bytes)}`;
            await setGradioImageFile(
                () => q("#forge_touch_inbox"),
                dataUrl,
                "from-webui.png",
                record
            );
            record.outcome = "received into the Canvas";
        } catch (error) {
            record.outcome = `failed: ${(error && error.message) || error}`;
            console.error(error);
        } finally {
            writeSendLog(record);
        }
    }

    /** Add a "Canvas" button to one output row, once. */
    function addReceiveButton(buttonsId, gallery) {
        const container = q(`#${buttonsId}`);
        if (!container || container.querySelector(".forge-touch-receive")) {
            return;
        }
        const template = container.querySelector("button");
        const button = template ? template.cloneNode(false) : document.createElement("button");
        button.id = `${buttonsId}_forge_touch_canvas`;
        button.className = `${template ? template.className : ""} forge-touch-receive`.trim();
        button.textContent = "Canvas";
        button.title = "Send this image to the Canvas editor";
        button.removeAttribute("aria-label");
        button.addEventListener("click", (event) => {
            event.preventDefault();
            receiveFromGallery(gallery);
        });
        container.appendChild(button);
    }

    async function addReceiveButtons() {
        for (const [buttonsId, galleryId] of RECEIVE_TARGETS) {
            try {
                await waitForSelector(`#${buttonsId}`, 30000);
                const gallery = await waitForSelector(`#${galleryId}`, 30000);
                addReceiveButton(buttonsId, gallery);
            } catch (e) {
                // One missing tab must not stop the others from binding.
                console.error(e);
            }
        }
    }

    /* ---------------------------------------------------------------- */
    /* Tool modes, focus mode and the editor's own brush                 */
    /* ---------------------------------------------------------------- */

    const TOOL_CLASSES = ["forge-touch-tool-crop", "forge-touch-tool-mask", "forge-touch-tool-expand"];

    /**
     * Find one of the editor's own toolbar buttons by what it calls itself.
     *
     * Gradio's ImageEditor owns the brush, the eraser and the crop handles;
     * there is no Python API for them. Matching on the accessible name is the
     * smallest hook that works, and every caller treats "not found" as normal:
     * the editor's toolbar is still on screen and still works.
     */
    function editorButton(names) {
        const scope = q(CANVAS);
        if (!scope) {
            return null;
        }
        for (const button of scope.querySelectorAll("button")) {
            const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`
                .trim()
                .toLowerCase();
            if (!label) {
                continue;
            }
            if (names.some((name) => label.indexOf(name) !== -1)) {
                return button;
            }
        }
        return null;
    }

    const EDITOR_TOOLS = {
        draw: ["draw", "brush", "pencil"],
        erase: ["eras"],
        crop: ["crop"],
    };

    function looksActive(button) {
        return (
            button.getAttribute("aria-pressed") === "true" ||
            button.classList.contains("active") ||
            button.classList.contains("selected")
        );
    }

    function activateEditorTool(name) {
        const button = editorButton(EDITOR_TOOLS[name] || []);
        if (!button) {
            return false;
        }
        // These are toggles in the editor's own toolbar: clicking the tool
        // that is already on turns it off again.
        if (!looksActive(button)) {
            button.click();
        }
        return true;
    }

    function setBrushSize(value) {
        const scope = q(CANVAS);
        if (!scope) {
            return false;
        }
        const slider = scope.querySelector("input[type='range']");
        if (!slider) {
            return false;
        }
        setNativeValue(slider, String(value));
        fire(slider, "input");
        fire(slider, "change");
        return true;
    }

    function setMaskHint(text) {
        const hint = q("#forge_touch_mask_hint");
        if (hint) {
            hint.textContent = text;
        }
    }

    function setActiveButton(buttons, active) {
        for (const button of buttons) {
            if (!button) {
                continue;
            }
            const selected = button === active;
            // Swapping Gradio's own variant classes keeps whatever the active
            // theme - Lobe included - decided a primary button looks like.
            button.classList.toggle("primary", selected);
            button.classList.toggle("secondary", !selected);
            button.classList.toggle("forge-touch-active", selected);
        }
    }

    function syncToolButtons(name) {
        const rootElement = q(ROOT);
        if (!rootElement) {
            return;
        }
        for (const className of TOOL_CLASSES) {
            rootElement.classList.toggle(className, className === `forge-touch-tool-${name}`);
        }
        setActiveButton(
            [q("#forge_touch_tool_crop"), q("#forge_touch_tool_mask"), q("#forge_touch_tool_expand")],
            q(`#forge_touch_tool_${name}`)
        );
    }

    function selectTool(name) {
        syncToolButtons(name);

        if (name === "crop") {
            activateEditorTool("crop");
        } else if (name === "mask") {
            selectBrush("draw");
        }
        // Expand does not paint: leave whatever tool the editor had alone so an
        // accidental swipe over the image cannot draw during setup.
        requestFit();
    }

    function selectBrush(which) {
        const applied = activateEditorTool(which === "erase" ? "erase" : "draw");
        setActiveButton(
            [q("#forge_touch_brush"), q("#forge_touch_erase")],
            q(which === "erase" ? "#forge_touch_erase" : "#forge_touch_brush")
        );
        if (!applied) {
            setMaskHint(
                "This Gradio build does not expose its brush controls; use the toolbar on the canvas itself."
            );
        } else {
            setMaskHint("");
        }
        return applied;
    }

    function requestFit() {
        // Gradio's editor re-fits its stage on a resize; it has no other public
        // way to be told the box it lives in has changed.
        try {
            window.dispatchEvent(new Event("resize"));
        } catch (e) {
            /* nothing else to try */
        }
    }

    function toggleFocus(force) {
        const rootElement = q(ROOT);
        if (!rootElement) {
            return;
        }
        const on = force === undefined ? !rootElement.classList.contains("forge-touch-focus") : !!force;
        rootElement.classList.toggle("forge-touch-focus", on);
        document.body.classList.toggle("forge-touch-focus-open", on);
        const button = q("#forge_touch_focus");
        if (button) {
            button.textContent = on ? "Exit Focus" : "Focus";
        }
        // The canvas box changes size on the way in and on the way out.
        setTimeout(requestFit, 50);
    }

    /* ---------------------------------------------------------------- */
    /* Boot                                                              */
    /* ---------------------------------------------------------------- */

    function bindLocalControls() {
        const bindings = [
            ["#forge_touch_tool_crop", () => selectTool("crop")],
            ["#forge_touch_tool_mask", () => selectTool("mask")],
            ["#forge_touch_tool_expand", () => selectTool("expand")],
            ["#forge_touch_brush", () => selectBrush("draw")],
            ["#forge_touch_erase", () => selectBrush("erase")],
            ["#forge_touch_fit", () => requestFit()],
            ["#forge_touch_focus", () => toggleFocus()],
        ];

        for (const [selector, handler] of bindings) {
            const element = q(selector);
            if (element && !element.dataset.forgeTouchBound) {
                element.dataset.forgeTouchBound = "1";
                element.addEventListener("click", handler);
            }
        }

        const size = q("#forge_touch_mask_size input[type='range']");
        if (size && !size.dataset.forgeTouchBound) {
            size.dataset.forgeTouchBound = "1";
            size.addEventListener("input", () => setBrushSize(size.value));
        }
        const sizeNumber = q("#forge_touch_mask_size input[type='number']");
        if (sizeNumber && !sizeNumber.dataset.forgeTouchBound) {
            sizeNumber.dataset.forgeTouchBound = "1";
            sizeNumber.addEventListener("change", () => setBrushSize(sizeNumber.value));
        }

        document.addEventListener("keydown", onEscape);
    }

    function onEscape(event) {
        if (event.key !== "Escape") {
            return;
        }
        const rootElement = q(ROOT);
        if (rootElement && rootElement.classList.contains("forge-touch-focus")) {
            toggleFocus(false);
        }
    }

    let lastToken = null;

    function pollPayload() {
        const rootElement = q(ROOT);
        if (!rootElement) {
            return;
        }
        // Nothing to do while the tab is not on screen.
        if (!rootElement.offsetParent && rootElement.offsetHeight === 0) {
            return;
        }
        bindLocalControls();

        const textarea = q("#forge_touch_payload textarea");
        if (!textarea || !textarea.value) {
            return;
        }
        let payload = null;
        try {
            payload = JSON.parse(textarea.value);
        } catch (e) {
            return;
        }
        if (!payload || !payload.token || payload.token === lastToken) {
            return;
        }
        lastToken = payload.token;
        send(payload);
    }

    async function debugReport() {
        const selectors = [
            "#img2img_image",
            "#img2maskimg",
            "#extras_image",
            "#forge_touch_canvas",
            "#forge_touch_inbox",
            "#tab_minipaint-button",
        ];
        const targets = {};
        for (const selector of selectors) {
            const element = q(selector);
            targets[selector] = element ? classifyTarget(element) : "MISSING";
        }
        const mode = img2imgModeInput();
        const report = {
            gradioVersion: (window.gradio_config || {}).version || null,
            hasForgeCanvas: !!q(".forge-container .forge-file-upload"),
            editorToolbar: {
                draw: !!editorButton(EDITOR_TOOLS.draw),
                erase: !!editorButton(EDITOR_TOOLS.erase),
                crop: !!editorButton(EDITOR_TOOLS.crop),
                sizeSlider: !!(q(CANVAS) && q(CANVAS).querySelector("input[type='range']")),
            },
            img2imgMode: mode ? mode.value : "NOT EXPOSED",
            targets,
            transfers: records.map((record) => ({
                destination: record.destination,
                outcome: record.outcome,
                steps: record.steps,
            })),
        };
        console.log(`${PREFIX} compatibility report`, report);
        return report;
    }

    function currentTool() {
        const rootElement = q(ROOT);
        for (const className of TOOL_CLASSES) {
            if (rootElement && rootElement.classList.contains(className)) {
                return className.replace("forge-touch-tool-", "");
            }
        }
        return "crop";
    }

    let started = false;

    function start() {
        const rootElement = q(ROOT);
        if (started || !rootElement) {
            return false;
        }
        started = true;
        try {
            // Tells the stylesheet that one panel at a time is now being
            // managed. Until this lands every panel is visible, so a tab whose
            // JavaScript never arrived is dense rather than unusable.
            rootElement.classList.add("forge-touch-js");
            info("touch Canvas mounted; adapter active");
            bindLocalControls();
            // Buttons only: the editor's own toolbar is left alone until the
            // user picks a mode, so nothing is clicked while the page is
            // still coming up.
            syncToolButtons(currentTool());
            addReceiveButtons();
            setInterval(pollPayload, POLL_MS);
        } catch (error) {
            // This runs from a MutationObserver among other places. Whatever
            // is wrong here, the WebUI around it must keep working.
            console.error(`${PREFIX} the adapter failed to start`, error);
        }
        return true;
    }

    // The tab is built with the rest of the UI, but this file can be evaluated
    // before it exists - and when the legacy editor is the mounted frontend it
    // never will, in which case nothing below ever runs.
    function watchForRoot() {
        if (start()) {
            return;
        }
        // The tab is built with the rest of the UI, and a shadow-root host
        // (Gradio's gradio-app) is not visible to an observer until it exists,
        // so this polls instead of watching every mutation in the document.
        // It gives up after a minute: when the legacy editor is the mounted
        // frontend the root never appears, and nothing should be left running
        // on the WebUI's behalf.
        let attempts = 0;
        const timer = setInterval(() => {
            if (start() || ++attempts > 120) {
                clearInterval(timer);
            }
        }, 500);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", watchForRoot);
    } else {
        watchForRoot();
    }

    window.forgeTouchCanvas.send = send;
    window.forgeTouchCanvas.selectTool = selectTool;
    window.forgeTouchCanvas.toggleFocus = toggleFocus;
    window.forgeTouchCanvas.debugReport = debugReport;
    window.forgeTouchCanvas.sendLog = () => records;
})();
