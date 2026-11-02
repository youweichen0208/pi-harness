import { expect, it } from "vitest";
import { missingPythonEditorTools, pythonFormatErrorLine } from "../../web/src/playground-format-error.js";

it("distinguishes missing editor dependencies from syntax and transient errors", () => {
	expect(missingPythonEditorTools("Install black in the selected Python environment.")).toBe(true);
	expect(missingPythonEditorTools("ModuleNotFoundError: No module named 'jedi'")).toBe(true);
	for (const message of ["Python analysis busy", "Python analysis cancelled, timed out or exceeded output limit", "black.parsing.InvalidInput: Cannot parse: 4:0: return a + b"]) {
		expect(missingPythonEditorTools(message)).toBe(false);
	}
});
it("extracts Black's source line without confusing traceback implementation lines", () => {
	expect(pythonFormatErrorLine('File "src/black/__init__.py", line 1214\nblack.parsing.InvalidInput: Cannot parse: 4:0: return a + b')).toBe("4");
	expect(pythonFormatErrorLine("Cannot parse for target version Python 3.13: 12:3: broken")).toBe("12");
	expect(pythonFormatErrorLine('File "src/black/__init__.py", line 1214')).toBeUndefined();
});
