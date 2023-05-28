import app from './../app.js';
import config from './../config.js';
import Base_tools_class from './../core/base-tools.js';
import Base_layers_class from './../core/base-layers.js';
import Helper_class from './../libs/helpers.js';
import Dialog_class from './../libs/popup.js';
import zoomView from '../libs/zoomView.js';

class Pan_tool_class extends Base_tools_class {

	constructor(ctx) {
		super();
		this.Base_layers = new Base_layers_class();
		this.name = 'pan';
		this.last_x = null;
		this.last_y = null;
	}

	load() {
		var _this = this;

		//mouse events
		document.addEventListener('mousedown', function (e) {
			_this.dragStart(e);
		});
		document.addEventListener('mousemove', function (e) {
			_this.dragMove(e);
		});
		document.addEventListener('mouseup', function (e) {
			_this.dragEnd(e);
		});

		// collect touch events
		document.addEventListener('touchstart', function (e) {
			_this.dragStart(e);
		});
		document.addEventListener('touchmove', function (e) {
			_this.dragMove(e);
		});
		document.addEventListener('touchend', function (e) {
			_this.dragEnd(e);
		});
	}

	dragStart(event) {
		var mouse = this.get_mouse_info(event);
		if (config.TOOL.name != this.name)
			return;
		if (mouse.click_valid == false) {
			return;
		}
		this.last_x = mouse.x;
		this.last_y = mouse.y;
		this.mousedown(event);
	}

	dragMove(event) {
		var mouse = this.get_mouse_info(event);
		if (config.TOOL.name != this.name)
			return;
		if (mouse.click_valid == false) {
			return;
		}

		this.mousemove(event);
	}

	dragEnd(event) {
		var mouse = this.get_mouse_info(event);
		if (config.TOOL.name != this.name)
			return;
		if (mouse.click_valid == false) {
			return;
		}
		this.Base_layers.render();
	}

	async mousedown(e) {
		var mouse = this.get_mouse_info(e);
		if (mouse.click_valid == false || config.mouse_lock === true) {
			return;
		}

		this.mousedown_dimensions = {
			x: Math.round(config.layer.x),
			y: Math.round(config.layer.y),
			width: Math.round(config.layer.width),
			height: Math.round(config.layer.height)
		};
	}

	mousemove(e) {
		var mouse = this.get_mouse_info(e);
		if (mouse.is_drag == false || mouse.click_valid == false || config.mouse_lock === true) {
			return;
		}
		zoomView.move(Math.floor((this.last_x-mouse.x)*-zoomView.getScale()*0.9), Math.floor((this.last_y-mouse.y)*-zoomView.getScale()*0.9))
		zoomView.apply()
		this.last_x = mouse.x;
		this.last_y = mouse.y;
		config.need_render = true;
	}

}

export default Pan_tool_class;
