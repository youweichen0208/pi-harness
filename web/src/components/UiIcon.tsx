import { LuSearch, LuBug, LuFlaskConical, LuBrush, LuPaperclip, LuImage, LuFileText, LuFolder, LuFolderOpen, LuLink, LuKeyRound, LuPuzzle, LuEye, LuSquareTerminal, LuSquarePen, LuSquarePlus, LuPencil, LuCompass, LuWrench, LuPlug, LuGitFork, LuClock, LuWrapText, LuMaximize2, LuTriangleAlert, LuSettings, LuCheck, LuX, LuZap, LuTimer, LuArrowUpRight, LuCornerDownRight } from "react-icons/lu";

const icons = { search: LuSearch, bug: LuBug, flask: LuFlaskConical, brush: LuBrush, paperclip: LuPaperclip, image: LuImage, file: LuFileText, folder: LuFolder, folderOpen: LuFolderOpen, link: LuLink, key: LuKeyRound, puzzle: LuPuzzle, eye: LuEye, squareTerminal: LuSquareTerminal, squarePen: LuSquarePen, squarePlus: LuSquarePlus, edit: LuPencil, compass: LuCompass, tool: LuWrench, plug: LuPlug, fork: LuGitFork, clock: LuClock, wrap: LuWrapText, maximize: LuMaximize2, warning: LuTriangleAlert, settings: LuSettings, check: LuCheck, close: LuX, zap: LuZap, timer: LuTimer, external: LuArrowUpRight, turn: LuCornerDownRight };
export type UiIconName = keyof typeof icons;
export function UiIcon({ name }: { name: UiIconName }) {
	const Icon = icons[name];
	return <Icon className="ui-icon" size={16} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}
