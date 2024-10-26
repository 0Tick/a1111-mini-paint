import app from './../../app.js';
import config from './../../config.js';
import Base_layers_class from './../../core/base-layers.js';
import Dialog_class from './../../libs/popup.js';
import Tools_settings_class from "../tools/settings";
import File_save_class from './save.js';
import File_open_class from './open.js';
import Helper_class from './../../libs/helpers.js';

var instance = null;
let isForge = false

/** 
 * manages sending files to other tabs
 */
class File_send_class {
	constructor() {
		//singleton
		if (instance) {
			return instance;
		}
		instance = this;

		this.Base_layers = new Base_layers_class();
		this.Helper = new Helper_class();
		this.POP = new Dialog_class();
		this.Tools_settings = new Tools_settings_class();
		this.Saver = new File_save_class();
		this.Loader = new File_open_class();
		this.Helper = new Helper_class();
		window.parent.a1111minipaint.recieve = this.recieveImage
		window.parent.a1111minipaint.createSendButton = this.createSendToMiniPaintButton
		isForge = window.parent.gradio_config.version >= "4.0.0"
	}



	dataURLtoFile(dataurl, filename) {
		var arr = dataurl.split(','),
			mime = arr[0].match(/:(.*?);/)[1],
			bstr = atob(arr[1]),
			n = bstr.length,
			u8arr = new Uint8Array(n);

		while (n--) {
			u8arr[n] = bstr.charCodeAt(n);
		}

		return new File([u8arr], filename, { type: mime });
	}
	updateGradioImage(element, dt) {
		let clearButton;
		if (isForge) {
			clearButton = element.querySelector('button.forge-btn[title="Remove"]');
		} else {
			clearButton = element.querySelector("button[aria-label='Remove Image']");
		}

		if (clearButton) {
			clearButton.click();
		}
		let input;
		if (isForge) {
			input = element.querySelector("input.forge-file-upload[type='file']");
		} else {
			input = element.querySelector("input[type='file']");
		}
		input.value = ''
		input.files = dt.files
		input.dispatchEvent(
			new Event('change', {
				bubbles: true,
				composed: true,
			})
		)
	}

	async sendImageCanvasEditor(type) {
		const imageDataURL = await this.Saver.export_data_url();

		var file = this.dataURLtoFile(imageDataURL, 'image.png');

		const dt = new DataTransfer();
		dt.items.add(file);

		const selector = type === "img2img_img2img" ? "#img2img_image" : "#img2maskimg";

		if (type === "img2img_img2img") {
			window.parent.switch_to_img2img();
		} else if (type === "img2img_inpaint") {
			window.parent.switch_to_inpaint();
		}

		let container;
		let imageElems;
		if (isForge) {
			container = window.parent.gradioApp().querySelector("#" + type + "_tab");
			imageElems = container.querySelectorAll('div.forge-container')[0];
			this.updateGradioImage(imageElems, dt);
		} else {
			container = window.parent.gradioApp().querySelector(selector);
			imageElems = container.querySelectorAll('div[data-testid="image"]');
			this.updateGradioImage(imageElems[0], dt);
		};
	}

	async sendImageCanvasEditorControlNet(type, index) {
		const imageDataURL = await this.Saver.export_data_url();

		var file = this.dataURLtoFile(imageDataURL, 'image.png');

		const dt = new DataTransfer();
		dt.items.add(file);

		const selector = type === "txt2img" ? "#txt2img_script_container" : "#img2img_script_container";

		if (type === "txt2img") {
			window.parent.switch_to_txt2img();
		} else if (type === "img2img") {
			window.parent.switch_to_img2img();
		}

		let container = window.parent.gradioApp().querySelector(selector);

		let element = container.querySelector('#controlnet');

		if (!element) {
			for (const spans of container.querySelectorAll < HTMLSpanElement > (
				'.cursor-pointer > span'
			)) {
				if (!spans.textContent?.includes('ControlNet')) {
					continue
				}
				if (spans.textContent?.includes('M2M')) {
					continue
				}
				element = spans.parentElement?.parentElement
			}
			if (!element) {
				console.error('ControlNet element not found')
				return
			}
		}
		let imageElems = element.querySelectorAll('div[data-testid="image"]')
		if (isForge) {
			if (!imageElems[Number(index)]) {
				let accordion = element.querySelector('.icon');
				if (accordion) {
					accordion.click();
				}
			}
			imageElems = Array.from(window.parent.gradioApp().querySelector(selector).querySelector("#controlnet").querySelectorAll('[id]')).filter(el =>
				el.id.match(new RegExp(String.raw`^${type}_controlnet_ControlNet-\d+_input_image$`, "g")))[index];
			this.updateGradioImage(imageElems, dt);
		}
		else {
			let _this = this
			if (!imageElems[Number(index)]) {
				let accordion = element.querySelector('.icon');

				if (accordion) {
					accordion.click();

					let controlNetAppeared = false;

					let observer = new MutationObserver(function (mutations) {
						mutations.forEach(function (mutation) {
							if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
								for (let i = 0; i < mutation.addedNodes.length; i++) {
									if (mutation.addedNodes[i].tagName === "INPUT") {

										controlNetAppeared = true;

										const imageElems2 = element.querySelectorAll('div[data-testid="image"]');

										_this.updateGradioImage(imageElems2[Number(index)], dt);

										observer.disconnect();

										return;
									}
								}
							}
						});
					});

					observer.observe(element, { childList: true, subtree: true });
				}
			} else {
				this.updateGradioImage(imageElems[Number(index * 4)], dt);
			}
		}

	};

	GUISendControlnet() {
		let maxModelAmount = Number(window.parent.gradioApp().querySelector("#a1111minipaint_controlnet_max").querySelector("textarea").value)
		let modelSelector = []
		for (let i = 0; i < maxModelAmount; i++) {
			modelSelector.push("Controlnet " + i)
		}
		let _this = this
		var settings = {
			title: "Send Image to Controlnet",
			params: [
				{ name: "txt2img", titel: "Type", values: ["Text to Image", "Image to Image"] },
				{ name: "cnn", titel: "Number", values: modelSelector }
			],
			on_finish: function (params) {
				_this.sendImageCanvasEditorControlNet(
					params.txt2img === "Text to Image" ? "txt2img" : "img2img",
					modelSelector.indexOf(params.cnn)
				)
			}
		};
		this.POP.show(settings);
	}

	GUISendImg2img() {
		let _this = this
		var settings = {
			title: "Send Image to Image2image",
			params: [
				{ name: "img2img", titel: "Type", values: ["Image2Image Init Image", "Image2Image Inpaint Image"] },
			],
			on_finish: function (params) {
				_this.sendImageCanvasEditor(params.img2img === "Image2Image Init Image" ? "img2img_img2img" : "img2img_inpaint")
			}
		};
		this.POP.show(settings);
	}

	async GUISendExtras() {
		const imageDataURL = await this.Saver.export_data_url();
		var file = this.dataURLtoFile(imageDataURL, 'image.png');
		const dt = new DataTransfer();
		dt.items.add(file);
		let container = window.parent.gradioApp().querySelector("#extras_image");
		let imageElems;
		if (isForge) {
			imageElems = container.querySelectorAll('div.forge-container')[0];
			window.parent.switch_to_extras()
			this.updateGradioImage(imageElems, dt);
		} else {
			imageElems = container.querySelectorAll('div[data-testid="image"]')
			window.parent.switch_to_extras()
			this.updateGradioImage(imageElems[0], dt);
		}
	}

	createSendToMiniPaintButton(queryId, gallery) {
		var existingButton = window.parent.gradioApp().querySelector(`#${queryId} button`);
		const FSC = new File_send_class();
		const addButton = () => { FSC.recieveImage(gallery) }
		if (window.parent.gradioApp().querySelector(`#${queryId}_open_in_minipaint`) == null) {
			const newButton = existingButton.cloneNode(true);
			newButton.id = `${queryId}_open_in_minipaint`;
			newButton.textContent = "✏️";
			newButton.title = "Send image to miniPaint tab.";
			newButton.addEventListener("click", addButton);
			if (isForge) {
				window.parent.gradioApp().querySelector(`#${queryId}`).appendChild(newButton);
			}
			else {
				window.parent.gradioApp().querySelector(`#${queryId} .form`).appendChild(newButton);
			}
		}
		else {
			existingButton = window.parent.gradioApp().querySelector(`#${queryId}_open_in_minipaint`);
			existingButton.addEventListener("click", addButton);
		}
	}

	recieveImage(gallery) {
		const img = gallery.querySelectorAll("img")[0];
		if (img) {
			var width = img.naturalWidth
			var height = img.naturalHeight
			var opener = new File_open_class()
			Array.from(window.parent.gradioApp().querySelector('#tabs').querySelectorAll('button')).find(button => button.textContent === 'Mini Paint ').click();
			var canv = document.createElement("canvas");
			canv.width = width;
			canv.height = height;
			var ctx = canv.getContext("2d");
			ctx.drawImage(img, 0, 0);
			opener.file_open_data_url_handler(canv.toDataURL("image/png"));
		}
	}
}
export default File_send_class