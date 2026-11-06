import { expect, it } from "vitest";
import { workspaceFilePath } from "../../web/src/workspace-file-path.js";

it.each([
	['D:\\projA', 'D:\\projB\\docs\\CONTEXT.md', true],
	['D:\\projA', 'D:\\projA-extra\\doc.md', true],
	['D:\\projA', 'C:\\projA\\doc.md', true],
	['D:\\projA', '..\\projB\\doc.md', true],
	['D:\\projA', 'd:/PROJA/docs/../doc.md', false],
	['D:\\projA', '\\projA\\doc.md', false],
	['D:\\projA', 'D:doc.md', true],
	['D:\\', 'D:\\doc.md', false],
	['\\\\host\\share\\project', '\\\\host\\other\\project\\doc.md', true],
	['\\\\host\\share\\project', '//HOST/share/project/doc.md', false],
	['/work/project', '/work/project-extra/doc.md', true],
	['/work/project', '../other/doc.md', true],
	['/work/project', 'docs/../../doc.md', true],
	['/work/project', '/work/project/docs/../doc.md', false],
	['/work/project', './docs/doc.md', false],
	['/work/project', '/work/PROJECT/doc.md', true],
	['/', '/doc.md', false],
] as const)('classifies %s + %s', (cwd, path, outside) => {
	expect(workspaceFilePath(cwd, path).outside).toBe(outside);
});
it('keeps the external absolute path intact and makes inside absolute paths relative', () => {
	expect(workspaceFilePath('D:\\projA', 'D:\\projB\\doc.md').fullPath).toBe('D:\\projB\\doc.md');
	expect(workspaceFilePath('D:\\projA', 'd:/PROJA/docs/doc.md').relativePath).toBe('docs/doc.md');
	expect(workspaceFilePath('/work/project', '../other/doc.md').fullPath).toBe('/work/other/doc.md');
});
