import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { KnowledgeEvidence, KnowledgeRequestContext } from "./knowledge-requests.js";
import type { KnowledgeSourceState } from "./knowledge-sources.js";
import type { WikiService } from "./wiki-service.js";

import type { WorkspaceGraphService } from "./workspace-graph.js";

export interface KnowledgeToolHost {
	graph?: Pick<WorkspaceGraphService, "execute">;
	getContext(): KnowledgeRequestContext | undefined;
	sourceState(): KnowledgeSourceState;
	skillFiles?(): string[];
	recordEvidence(evidence: KnowledgeEvidence): void;
	parent(): { model: NonNullable<AgentSession["model"]>; thinkingLevel: AgentSession["thinkingLevel"]; modelRuntime: AgentSession["modelRuntime"]; agentDir: string };
	wiki: WikiService;
}
