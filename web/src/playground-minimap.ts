import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** A bounded overview of the document; navigation never edits source text. */
export function playgroundMinimap(label: string) {
	return ViewPlugin.fromClass(class {
		canvas: HTMLCanvasElement;
		frame = 0;
		observer: ResizeObserver;
		constructor(readonly view: EditorView) {
			this.canvas = view.dom.ownerDocument.createElement("canvas");
			this.canvas.className = "scratch-minimap";
			this.canvas.tabIndex = 0;
			this.canvas.setAttribute("role", "region");
			this.canvas.setAttribute("aria-label", label);
			view.dom.append(this.canvas);
			this.canvas.addEventListener("pointerdown", this.navigate);
			this.canvas.addEventListener("keydown", this.key);
			view.scrollDOM.addEventListener("scroll", this.schedule);
			this.observer = new ResizeObserver(this.schedule);
			this.observer.observe(view.dom);
			this.schedule();
		}
		schedule = () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.draw()); };
		update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some(tr => tr.effects.length)) this.schedule(); }
		metrics() {
			const height = this.canvas.clientHeight;
			const step = 3;
			const full = this.view.state.doc.lines * step;
			const scroll = this.view.scrollDOM;
			const offset = Math.max(0, full - height) * scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight);
			return { height, step, offset };
		}
		draw() {
			const width = this.canvas.clientWidth;
			const { height, step, offset } = this.metrics();
			if (!width || !height) return;
			const scale = this.view.dom.ownerDocument.defaultView?.devicePixelRatio || 1;
			this.canvas.width = width * scale; this.canvas.height = height * scale;
			const ctx = this.canvas.getContext("2d"); if (!ctx) return;
			ctx.scale(scale, scale);
			const css = getComputedStyle(this.view.dom);
			const color = (token: string) => css.getPropertyValue(`--pg-code-${token}`).trim();
			ctx.font = '2px monospace';
			const doc = this.view.state.doc;
			for (let n = Math.floor(offset / step) + 1; n <= Math.min(doc.lines, Math.ceil((offset + height) / step)); n++) {
				const text = doc.line(n).text.replace(/\t/g, "    ").slice(0, 100);
				for (const match of text.matchAll(/#[^\n]*|"[^"\n]*"|'[^'\n]*'|\b(?:def|class|if|else|elif|while|for|return|import|from|try|except|break|continue)\b|\b\d+\b|[^\s]+/g)) {
					ctx.fillStyle = color(match[0].startsWith('#') ? 'comment' : /^["']/.test(match[0]) ? 'str' : /^\d+$/.test(match[0]) ? 'num' : /^(def|class|if|else|elif|while|for|return|import|from|try|except|break|continue)$/.test(match[0]) ? 'kw' : 'fg');
					ctx.fillText(match[0], 4 + match.index * 1.2, (n - 1) * step - offset + 2);
				}
			}
			const first = doc.lineAt(this.view.viewport.from).number;
			const last = doc.lineAt(this.view.viewport.to).number;
			ctx.fillStyle = color('chip'); ctx.globalAlpha = .35;
			ctx.fillRect(0, (first - 1) * step - offset, width, Math.min(height, (last - first + 1) * step));
		}
		navigate = (event: PointerEvent) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const { step, offset } = this.metrics();
			const line = Math.max(1, Math.min(this.view.state.doc.lines, Math.floor((event.clientY - this.canvas.getBoundingClientRect().top + offset) / step) + 1));
			this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.doc.line(line).from, { y: "center" }) });
			this.canvas.focus({ preventScroll: true });
		};
		key = (event: KeyboardEvent) => {
			if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const scroll = this.view.scrollDOM;
			scroll.scrollTop = event.key === "Home" ? 0 : event.key === "End" ? scroll.scrollHeight : scroll.scrollTop + (event.key.endsWith("Up") ? -1 : 1) * (event.key.startsWith("Page") ? scroll.clientHeight : 22);
		};
		destroy() { cancelAnimationFrame(this.frame); this.observer.disconnect(); this.view.scrollDOM.removeEventListener("scroll", this.schedule); this.canvas.remove(); }
	});
}
