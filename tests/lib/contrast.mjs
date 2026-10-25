export async function contrastRatios(page, selector, pseudo = null) {
	return page.locator(selector).evaluateAll((elements, pseudo) => {
		const context = document.createElement("canvas").getContext("2d");
		const parse = value => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data];
		};
		const luminance = rgba => {
			const channels = rgba.slice(0, 3).map(value => {
				const channel = value / 255;
				return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
			});
			return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
		};
		return elements.map(element => {
			let background = getComputedStyle(document.body).backgroundColor;
			for (let node = element; node; node = node.parentElement) {
				const candidate = getComputedStyle(node).backgroundColor;
				if (parse(candidate)[3] === 255) { background = candidate; break; }
			}
			const foregroundColor = getComputedStyle(element, pseudo).color;
			const foreground = luminance(parse(foregroundColor));
			const surface = luminance(parse(background));
			return { text: element.textContent?.trim() ?? "", foreground: foregroundColor, background, ratio: (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05) };
		});
	}, pseudo);
}
