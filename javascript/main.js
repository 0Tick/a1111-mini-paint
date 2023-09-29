window.a1111minipaint = {}
window.a1111minipaint.onload = () => {
        setTimeout(() =>{
                a1111minipaint.createSendButton("image_buttons_txt2img", window.parent.txt2img_gallery);
                a1111minipaint.createSendButton("image_buttons_img2img", window.parent.img2img_gallery);
                a1111minipaint.createSendButton("image_buttons_extras", window.parent.extras_gallery);
        }, )
}