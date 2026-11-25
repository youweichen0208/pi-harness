---
name: update-graph
description: Refresh the published local code relationship index for the current registered Workspace. Invoke explicitly with /update-graph or /skill:update-graph.
disable-model-invocation: true
---

# Update Workspace graph

Invoke with no argument or the exact unique name or ID of a Workspace containing the current project. A maintenance request covers all repositories in that Workspace.

The user requested an incremental refresh. Call `graph_update` once. The host owns changed, moved and deleted file detection. If the requested scope excludes a repository, respect the restriction and explain a scope error.

Report the returned state and version in the user's language. If no published index exists, explain how to start the initial build with `/build-graph`. For an active job, direct the user to Graph to see progress. A started job may still fail before publication.
