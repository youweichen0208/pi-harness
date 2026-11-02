/** Classify existing analysis errors without treating invalid source as missing tools. */
export function missingPythonEditorTools(message: string): boolean {
	return /Install (?:black|jedi) in the selected Python environment\./.test(message)
		|| /No module named ['"](?:black|jedi)['"]/.test(message);
}

export function pythonFormatErrorLine(message: string): string | undefined {
	return /Cannot parse[^:\n]*:\s*(\d+):\d+:/.exec(message)?.[1];
}
