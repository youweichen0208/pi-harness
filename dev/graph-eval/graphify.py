"""Measure a pinned, headless Graphify build and an incremental SDK edit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
VERSION = "0.9.119"
SDK_FILE = "packages/coding-agent/src/core/agent-session.ts"
HARNESS_FILE = "server/agent-service.ts"
# These are lookup keys only. Positions and links below always come from Graphify.
WANTED = {
	("sdk", SDK_FILE): {"_emitAgentSettled", "_emit", "subscribe"},
	("harness", HARNESS_FILE): {"bindSession", "onEvent"},
}


def copy_sample(samples, target):
	corpus = json.loads((HERE / "corpus.json").read_text())
	for source, spec in corpus.items():
		for relative, digest in spec["files"].items():
			data = (samples / source / relative).read_bytes()
			if hashlib.sha256(data).hexdigest() != digest:
				raise ValueError(f"Content differs from pinned corpus: {source}/{relative}")
			path = target / source / relative
			path.parent.mkdir(parents=True, exist_ok=True)
			path.write_bytes(data)


def measure(cli, args, root):
	env = {**os.environ, "GRAPHIFY_BACKEND": "none", "GRAPHIFY_QUERY_LOG_DISABLE": "1", "PYTHONHASHSEED": "0"}
	with tempfile.TemporaryFile() as log:
		start = time.perf_counter()
		with subprocess.Popen([cli, *args], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT) as proc:
			peak = None
			if hasattr(os, "wait4"):
				_, status, usage = os.wait4(proc.pid, 0)
				proc.returncode = os.waitstatus_to_exitcode(status)
				peak = usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024
			else:
				proc.wait()
			duration = time.perf_counter() - start
			if proc.returncode:
				log.seek(0)
				raise RuntimeError(log.read().decode(errors="replace"))
	return {"seconds": round(duration, 3), "peakRssBytes": peak}


def graph_observations(path):
	data = json.loads(path.read_text())
	nodes = {node["id"]: node for node in data["nodes"]}
	owners = []
	for node in nodes.values():
		source, relative = node.get("repo"), node.get("source_file")
		name = node["label"].removeprefix(".").removesuffix("()")
		if name in WANTED.get((source, relative), set()) and node.get("_callable"):
			owners.append({"source": source, "path": relative, "id": node["id"], "name": name,
				"line": int(node["source_location"].removeprefix("L"))})
	owners.sort(key=lambda row: (row["source"], row["line"], row["id"]))
	unresolved = []
	for owner in owners:
		parked = nodes[owner["id"]].get("metadata", {}).get("unresolved_calls", [])
		if owner["name"] == "_emitAgentSettled":
			unresolved.extend(parked)
	ids = {node["id"] for node in owners}
	calls, cross = [], []
	for link in data["links"]:
		source, target = link.get("_src", link["source"]), link.get("_tgt", link["target"])
		repos = {nodes[source].get("repo"), nodes[target].get("repo")}
		if source in ids and target in ids and link["relation"] == "calls":
			calls.append({"source": source, "target": target, "relation": "calls",
				"path": link.get("source_file"), "location": link.get("source_location"),
				"confidence": link.get("confidence")})
		if repos == {"sdk", "harness"}:
			cross.append({"source": source, "target": target, "relation": link["relation"],
				"path": link.get("source_file"), "location": link.get("source_location"),
				"confidence": link.get("confidence")})
	order = lambda e: (e["source"], e["target"], str(e["location"]))
	return {"owners": owners, "calls": sorted(calls, key=order)}, {
		"nodes": len(nodes), "edges": len(data["links"]),
		"hyperedges": len(data.get("hyperedges", [])), "crossSourceEdges": sorted(cross, key=order),
		"unresolvedEmitterCalls": unresolved,
	}


def stage(cli, root, refresh):
	runs = {}
	for source in refresh:
		runs[source] = measure(cli, ["extract", source, "--code-only", "--max-workers", "1"], root)
	graphs = [f"{source}/graphify-out/graph.json" for source in ("sdk", "harness")]
	runs["merge"] = measure(cli, ["merge-graphs", *graphs, "--out", "merged-graph.json"], root)
	merged = root / "merged-graph.json"
	owners, observations = graph_observations(merged)
	sizes = {source: sum(file.stat().st_size for file in (root / source / "graphify-out").rglob("*")
		if file.is_file()) for source in ("sdk", "harness")}
	sizes["merged"] = merged.stat().st_size
	return owners, {**observations, "runs": runs, "outputBytes": sizes}


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--samples", type=Path, default=PROJECT / ".scratch/graph-eval/samples")
	parser.add_argument("--cli", default="graphify", help="path to the pinned Graphify CLI")
	parser.add_argument("--owners", type=Path, help="write baseline owner nodes and native calls")
	args = parser.parse_args()
	cli = shutil.which(args.cli)
	if cli is None:
		parser.error("Install graphifyy==0.9.119 in an isolated Python environment")
	cli = os.path.abspath(cli)
	version = subprocess.check_output([cli, "--version"], text=True).strip()
	if version != f"graphify {VERSION}":
		parser.error(f"Expected graphify {VERSION}, found {version}")
	with tempfile.TemporaryDirectory(prefix="pi-graphify-eval-") as tmp:
		root = Path(tmp)
		copy_sample(args.samples, root)
		baseline, cold = stage(cli, root, ("sdk", "harness"))
		graph_file = root / "merged-graph.json"
		before_ids = {n["id"] for n in json.loads(graph_file.read_text())["nodes"]}
		unchanged, warm = stage(cli, root, ("sdk", "harness"))
		after_ids = {n["id"] for n in json.loads(graph_file.read_text())["nodes"]}
		warm["removedNodeIds"] = sorted(before_ids - after_ids)
		warm["addedNodeIds"] = sorted(after_ids - before_ids)
		if unchanged != baseline:
			raise RuntimeError("Unchanged refresh changed owner or call observations")
		emitter = root / "sdk" / SDK_FILE
		content = emitter.read_text()
		emit = 'this._emit({ type: "agent_settled", aborted });'
		if content.count(emit) != 1:
			raise ValueError("SDK sample lacks the expected unique emitter call")
		emitter.write_text(content.replace(emit, emit.replace("agent_settled", "alternate")))
		retagged, retag = stage(cli, root, ("sdk",))
		emitter.write_text(content.replace(emit, "void aborted;"))
		updated, edit = stage(cli, root, ("sdk",))
		if args.owners:
			args.owners.write_text(json.dumps(baseline, indent="\t") + "\n")
		print(json.dumps({"engine": version, "cold": cold, "unchanged": warm, "retag": retag, "edit": edit,
			"callsAfterRetag": retagged["calls"],
			"callsAfterEdit": updated["calls"]}, indent="\t"))


if __name__ == "__main__":
	main()
