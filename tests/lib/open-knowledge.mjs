/** Configure the fixture library, then open it through the public navigation. */
export async function openKnowledge(page, cwd, path = "README.md") {
	await page.evaluate(async ({ cwd, path }) => {
		const post = async body => {
			const response = await fetch("/api/knowledge-library", {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(await response.text());
			return response.json();
		};
		const config = await post({ action: "configure", cwd });
		await post({ action: "remember", cwd: config.cwd, path });
	}, { cwd, path });
	await page.getByRole("button", { name: "知识库", exact: true }).click();
}
