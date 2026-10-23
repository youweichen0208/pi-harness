export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48];
export const LINE_HEIGHTS = [1, 1.5, 1.74, 2, 2.5, 3];
type OptionLabel = "richParagraph" | "richHeading" | "richDefaultColor" | "richColorBlue" | "richColorGreen" | "richColorRed" | "richHighlightClear" | `richHighlight_${"yellow" | "green" | "blue" | "pink" | "purple"}` | `richAlign_${"left" | "center" | "right" | "justify"}`;
export interface RichCommandOption { value: string; label?: OptionLabel; suffix?: string; text?: string }
const define = <L extends string>(label: L, options?: RichCommandOption[]) => ({ label, options });
const definitions = {
	undo: define("richUndo"), redo: define("richRedo"),
	bold: define("richBold"), italic: define("richItalic"), strikeThrough: define("richStrike"), underline: define("richUnderline"),
	superscript: define("richSuperscript"), subscript: define("richSubscript"),
	formatBlock: define("richParagraph", [{ value: "p", label: "richParagraph" }, ...[1,2,3,4,5,6].map(n => ({ value: `h${n}`, label: "richHeading" as const, suffix: ` ${n}` }))]),
	"font-size": define("richFontSize", FONT_SIZES.map(n => ({ value: `${n}px`, text: `${n}px` }))),
	color: define("richTextColor", [{ value: "--text", label: "richDefaultColor" }, { value: "--accent", label: "richColorBlue" }, { value: "--action", label: "richColorGreen" }, { value: "--red", label: "richColorRed" }]),
	highlight: define("richTextHighlight", [...(["yellow","green","blue","pink","purple"] as const).map(color => ({ value: color, label: `richHighlight_${color}` as const })), { value: "clear", label: "richHighlightClear" }]),
	"text-align": define("richAlignment", (["left","center","right","justify"] as const).map(value => ({ value, label: `richAlign_${value}` as const }))),
	"line-height": define("richLineHeight", LINE_HEIGHTS.map(n => ({ value: String(n), text: `${n}×` }))),
	insertUnorderedList: define("richList"), insertOrderedList: define("richOrderedList"),
	task: define("richTaskList"), indent: define("richIndent"), outdent: define("richOutdent"), plainBlock: define("richPlainBlock"),
};
export type RichCommand = keyof typeof definitions;
export type RichCommandLabel = typeof definitions[RichCommand]["label"] | OptionLabel;

interface EditorAdapter {
	editable(): boolean;
	captureSelection(): void;
	restoreSelection(): boolean;
	execute(command: RichCommand, value?: string): void;
	insert(id: string): void;
	color(variable: string): string;
}
/** One command catalogue and selection protocol for both toolbar adapters. */
export class RichCommands {
	constructor(private readonly editor: EditorAdapter) {}
	get enabled() { return this.editor.editable(); }
	describe(id: RichCommand) { return definitions[id]; }
	prepare = () => { if (this.enabled) this.editor.captureSelection(); };
	execute = (id: RichCommand, value?: string): boolean => {
		const command = definitions[id];
		if (!this.enabled || !command || (command.options && !command.options.some(option => option.value === value))) return false;
		this.prepare();
		if (!this.editor.restoreSelection()) return false;
		this.editor.execute(id, id === "color" ? this.editor.color(value!) : value);
		return true;
	};
	insert = (id: string) => {
		if (!this.enabled) return;
		this.prepare();
		if (this.editor.restoreSelection()) this.editor.insert(id);
	};
}
