/** Internal Python programs travel with the compiled server; no loose runtime assets. */
export const PYTHON_RUNNER = String.raw`
import sys, json, pathlib, inspect, asyncio, traceback
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
source, mode = sys.argv[1:3]
extra = sys.argv[3:6]
sys.argv = [source]
code = compile(pathlib.Path(source).read_text(encoding="utf-8"), source, "exec")
if mode == "check":
    sys.exit(0)
if mode == "program":
    exec(code, {"__name__": "__main__", "__file__": source})
else:
    config_path, result_path, maximum = extra
    data = json.loads(pathlib.Path(config_path).read_text(encoding="utf-8"))
    def value(v, kind):
        return None if v.get("isNull") else v["text"] if kind == "str" else json.loads(v["text"])
    result = {"status": "error"}
    try:
        scope = {"__name__": "__playground__", "__file__": source}
        exec(code, scope)
        method, case = data["method"], data["case"]
        args = [value(v, p["type"]) for v, p in zip(case["args"], method["parameters"])]
        actual = scope[method["name"]](*args)
        if inspect.isawaitable(actual):
            actual = asyncio.run(actual)
        result["actual"] = repr(actual)
        if "expected" in case:
            expected = value(case["expected"], method["returnType"])
            result["expected"] = repr(expected)
            result["status"] = "passed" if actual == expected else "failed"
        else:
            result["status"] = "unasserted"
    except BaseException:
        result["error"] = traceback.format_exc()
    encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
    pathlib.Path(result_path).write_bytes(encoded if len(encoded) <= int(maximum) else b"overflow")
`;

export const PYTHON_ANALYSIS = String.raw`
import sys, json, ast, os
sys.stdout.reconfigure(encoding="utf-8")
request = json.load(sys.stdin)
code = request["code"]
action = request["action"]
if request.get("toolsPath"):
    sys.path.insert(0, request["toolsPath"])
def utf16(s):
    return len(s.encode("utf-16-le")) // 2
if action == "format":
    import black
    print(json.dumps({"code": black.format_str(code, mode=black.Mode())}))
else:
    import jedi
    jedi.settings.cache_directory = os.path.join(os.getcwd(), "cache")
    prefix = code.encode("utf-16-le")[:request["offset"] * 2].decode("utf-16-le", errors="ignore")
    line, column = prefix.count("\n") + 1, len(prefix.rsplit("\n", 1)[-1])
    script = jedi.Script(code=code, path=os.path.join(os.getcwd(), "scratch.py"), project=jedi.Project(os.getcwd(), sys_path=sys.path, load_unsafe_extensions=False))
    if action == "completion":
        items = []
        for item in script.complete(line, column)[:100]:
            length = item.get_completion_prefix_length()
            start = utf16(prefix[:-length]) if length else utf16(prefix)
            items.append({"label": item.name, "detail": item.description, "kind": 3 if item.type == "function" else 7 if item.type == "class" else 6, "edit": {"from": start, "to": request["offset"], "text": item.name}, "additionalEdits": []})
        result = {"items": items}
    elif action == "signature":
        result = {"signatures": [s.to_string() for s in script.get_signatures(line, column)][:5]}
    else:
        diagnostics = []
        try:
            ast.parse(code)
        except SyntaxError as error:
            lines = code.splitlines(keepends=True)
            prefix = "".join(lines[:(error.lineno or 1) - 1])
            content = lines[(error.lineno or 1) - 1] if (error.lineno or 1) <= len(lines) else ""
            start = min(utf16(code), utf16(prefix + content[:max(0, (error.offset or 1) - 1)]))
            diagnostics.append({"from": start, "to": min(utf16(code), start + 1), "severity": "error", "message": error.msg})
        result = {"diagnostics": diagnostics}
    print(json.dumps(result))
`;
