---
name: build-graph
description: Build the local code relationship index for the current registered Workspace. Invoke explicitly with /build-graph or /skill:build-graph.
disable-model-invocation: true
---

# Build Workspace graph

Invoke with no argument or the exact unique name or ID of a Workspace containing the current project. A maintenance request covers all repositories in that Workspace.

The user requested a full build for the selected Workspace. Call `graph_build` once. The host resolves the registered repositories, runs the parser and publishes the index. If the request restricts source access, respect the restriction and explain a scope error.

Report the returned state in the user's language. Distinguish a job that has started from a published version. Direct the user to Graph to follow a running job. Include the version or failure returned by the service when available.
