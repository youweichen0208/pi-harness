import { useT } from "../i18n";
import type { TextTree, TreeNode } from "../design-tree";
import { CopyButton } from "./copy-button";

function Rows({ nodes, nested }: { nodes: TreeNode[]; nested?: boolean }) {
	return <ul className={nested ? "design-tree-children" : "design-tree-rows"}>
		{nodes.map((node, index) => <li key={`${node.id ?? node.title}-${index}`}>
			<div className="design-tree-row">
				{node.id && <span className="design-tree-id">{node.id}</span>}
				<span className="design-tree-title">{node.title}</span>
				{node.note && <span className="design-tree-note">{node.note}</span>}
				{node.tag && <span className="design-tree-tag">{node.tag}</span>}
			</div>
			{node.children.length > 0 && <Rows nodes={node.children} nested />}
		</li>)}
	</ul>;
}

/** 4a: a light structured tree instead of box-drawing art in a dark code block. */
export function DesignTree({ tree, source }: { tree: TextTree; source: string }) {
	const t = useT();
	return <div className="design-tree">
		<div className="design-tree-root">
			<span className="design-tree-root-label">{t("designTreeRoot")}</span>
			<strong>{tree.root}</strong>
			<span className="design-tree-summary">{t("designTreeBranches", { n: tree.children.length })}{tree.commonTag ? ` · ${t("designTreeCommonTag", { tag: tree.commonTag })}` : ""}</span>
			<CopyButton text={source} />
		</div>
		<Rows nodes={tree.children} />
	</div>;
}
