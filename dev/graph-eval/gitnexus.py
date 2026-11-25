"""Evaluate a pinned local GitNexus CLI against the verified M2 corpus."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ENGINE_VERSION = '1.6.12'
OWNER_NAMES = {'sdk': ['_emitAgentSettled', '_emit', 'subscribe'], 'harness': ['bindSession', 'onEvent']}
OWNER_PATH = {'sdk': 'packages/coding-agent/src/core/agent-session.ts', 'harness': 'server/agent-service.ts'}
GROUP = 'settled'


def read_json(path):
    return json.loads(path.read_text())


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def allocated_bytes(path):
    return int(subprocess.check_output(['du', '-sk', path], text=True).split()[0]) * 1024


def parse_json(text):
    # Several group commands print progress before the single final JSON value.
    for m in re.finditer(r'^[\[{]', text, re.M):
        try:
            return json.loads(text[m.start():])
        except json.JSONDecodeError:
            continue
    raise ValueError('No complete JSON response; inspect the run log')


class Run:
    def __init__(self, scratch, tool_prefix, samples):
        self.path = Path(tempfile.mkdtemp(prefix='gitnexus-run-', dir=scratch))
        self.tool = tool_prefix / 'node_modules/gitnexus'
        assert read_json(self.tool / 'package.json')['version'] == ENGINE_VERSION
        self.cli = self.tool / 'dist/cli/index.js'
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.path / 'home'),
                    'GITNEXUS_HOME': str(self.path / 'registry'), 'GITNEXUS_NO_UPDATE_NOTIFIER': '1',
                    'CI': '1', 'GIT_CONFIG_NOSYSTEM': '1', 'LANG': 'en_US.UTF-8'}
        (self.path / 'home').mkdir()
        self.metrics = {}
        corpus = read_json(HERE / 'corpus.json')
        for source, record in corpus.items():
            repo = self.path / source
            repo.mkdir()
            for path, digest in record['files'].items():
                content = (samples / source / path).read_bytes()
                if hashlib.sha256(content).hexdigest() != digest:
                    raise ValueError(f'Corpus mismatch: {source}/{path}')
                target = repo / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            self.git(repo, 'init', '-q')
            self.commit(repo, 'pinned sample')

    def git(self, cwd, *args):
        subprocess.run(['git', '-c', 'user.name=M2 Eval', '-c', 'user.email=eval@example.invalid',
                        *args], cwd=cwd, env=self.env, check=True, capture_output=True)

    def commit(self, cwd, message):
        self.git(cwd, 'add', '.')
        self.git(cwd, 'commit', '-qm', message)

    def invoke(self, step, *args):
        logfile = self.path / (step + '.log')
        errfile = self.path / (step + '.err')
        darwin = platform.system() == 'Darwin'
        flag = '-l' if darwin else '-v'
        started = time.monotonic()
        with logfile.open('w') as out, errfile.open('w') as err:
            result = subprocess.run(['/usr/bin/time', flag, 'node', self.cli, *args],
                                    cwd=self.path, env=self.env, stdout=out, stderr=err, timeout=240)
        elapsed = round(time.monotonic() - started, 3)
        stderr = errfile.read_text()
        match = re.search(r'(\d+)\s+maximum resident set size', stderr) if darwin else re.search(
            r'Maximum resident set size \(kbytes\):\s*(\d+)', stderr)
        rss = int(match[1]) * (1 if darwin else 1024) if match else None
        self.metrics[step] = {'seconds': elapsed, 'max_rss_bytes': rss, 'exit': result.returncode}
        print(step, self.metrics[step], flush=True)
        if result.returncode:
            raise RuntimeError(f'{step}: see {errfile} and {logfile}')
        return logfile.read_text()

    def analyze(self, source, phase):
        result = self.invoke(f'{phase}-{source}', 'analyze', str(self.path / source),
                             '--index-only', '--name', source)
        if not (self.path / source / '.gitnexus' / 'meta.json').is_file():
            raise RuntimeError(f'Index metadata missing after analyzing {source}: {result[-300:]}')

    def sync(self, step):
        value = parse_json(self.invoke(step, 'group', 'sync', GROUP, '--json'))
        if value.get('unreadableRepos') or value.get('missingRepos'):
            raise RuntimeError(f'Member index incomplete in {step}')
        return value

    def disk(self):
        return {source: allocated_bytes(self.path / source / '.gitnexus') for source in OWNER_NAMES} | {
            'registry': allocated_bytes(self.path / 'registry')}

    def query_owners(self, source):
        quoted = ', '.join("'" + n + "'" for n in OWNER_NAMES[source])
        query = (f'MATCH (n:Method) WHERE n.name IN [{quoted}] '
                 'RETURN n.name AS name, n.filePath AS path, n.startLine AS line ORDER BY name')
        value = parse_json(self.invoke('owners-' + source, 'cypher', query, '-r', source))
        if isinstance(value, dict) and value.get('error'):
            raise ValueError(value['error'])
        rows = table_rows(value)
        owners = []
        for name, path, line in rows:
            if name in OWNER_NAMES[source] and path == OWNER_PATH[source]:
                owners.append({'source': source, 'path': path, 'name': name, 'line': int(line) + 1})
        for owner in owners:
            lines = (self.path / source / owner['path']).read_text().splitlines()
            if owner['name'] + '(' not in lines[owner['line'] - 1]:
                raise ValueError(f'Native owner position mismatch: {owner}')
        return owners


def table_rows(value):
    if isinstance(value, list):
        return [[r['name'], r['path'], r['line']] for r in value]
    table = value['markdown']
    lines = [row for row in table.splitlines() if row.startswith('|')]
    return [[c.strip() for c in row.strip('|').split('|')] for row in lines[2:]]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    scratch = HERE.parents[1] / '.scratch/graph-eval'
    p.add_argument('--samples', type=Path, default=scratch / 'samples')
    p.add_argument('--tools', type=Path, default=scratch / 'gitnexus-tools')
    p.add_argument('--scratch', type=Path, default=scratch)
    p.add_argument('--output', type=Path, default=None)
    args = p.parse_args()
    run = Run(args.scratch.resolve(), args.tools.resolve(), args.samples.resolve())
    print(run.path, flush=True)
    for source in OWNER_NAMES:
        run.analyze(source, 'cold')
    run.invoke('group-create', 'group', 'create', GROUP)
    for source in OWNER_NAMES:
        run.invoke('group-add-' + source, 'group', 'add', GROUP, source, source)
    cold = run.sync('cold-group-sync')
    contracts = parse_json(run.invoke('contracts', 'group', 'contracts', GROUP, '--json'))
    impact = parse_json(run.invoke('impact', 'group', 'impact', GROUP, '--target', '_emitAgentSettled',
                                   '--repo', 'sdk', '--direction', 'downstream', '--json'))
    scoped = parse_json(run.invoke('scoped-impact', 'group', 'impact', GROUP, '--target', '_emitAgentSettled',
                                   '--repo', 'sdk', '--direction', 'downstream', '--subgroup', 'sdk', '--json'))
    owners = [item for source in OWNER_NAMES for item in run.query_owners(source)]
    owner_export = {'engine': 'gitnexus@' + ENGINE_VERSION, 'owners': owners}
    out = args.output or run.path
    out.mkdir(parents=True, exist_ok=True)
    dump(out / 'gitnexus-owners.json', owner_export)

    # Candidate must expose an actual directed relation. Same names, plaintext
    # matches and group-query hits do not establish a cross-repository path.
    queries = {
        'sdk-emit': ('sdk', "MATCH (a:Method)-[r:CodeRelation]->(b:Method) WHERE a.name='_emitAgentSettled' "
                     "AND b.name='_emit' RETURN a.id AS src,r.type AS relation,b.id AS dst"),
        'sdk-listeners': ('sdk', "MATCH (a:Method)-[r:CodeRelation]->(b) WHERE a.name IN ['_emit','subscribe'] "
                          "AND b.name='_eventListeners' RETURN DISTINCT a.id AS src,r.type AS relation,b.id AS dst"),
        'host-callback': ('harness', "MATCH (a:Method)-[r:CodeRelation]->(cb:Function)-[s:CodeRelation]->(b:Method) "
                          "WHERE a.name='bindSession' AND b.name='onEvent' AND r.type='CALLS' AND s.type='CALLS' "
                          "RETURN DISTINCT a.id AS src,cb.id AS callback,b.id AS dst"),
        'host-property': ('harness', "MATCH (a:Method)-[r:CodeRelation]->(b) WHERE a.name='onEvent' "
                          "AND b.name='lastTaskEndedAt' RETURN a.id AS src,r.type AS relation,b.id AS dst"),
    }
    local_evidence = {}
    for label, (source, query) in queries.items():
        local_evidence[label] = parse_json(run.invoke(label, 'cypher', query, '-r', source))
        if isinstance(local_evidence[label], dict) and local_evidence[label].get('error'):
            raise RuntimeError(f'Query {label} failed: {local_evidence[label]["error"]}')
    before = run.disk()
    cold_indexes = {}
    for source in OWNER_NAMES:
        meta = read_json(run.path / source / '.gitnexus' / 'meta.json')
        cold_indexes[source] = {'stats': meta['stats'], 'capabilities': meta['capabilities']}
    consumer = run.path / 'harness' / OWNER_PATH['harness']
    original = consumer.read_text()
    old = 'case "agent_settled": {'
    assert original.count(old) == 1
    consumer.write_text(original.replace(old, 'case "agent_settled_removed_in_eval": {'))
    run.git(consumer.parent.parent, 'add', OWNER_PATH['harness'])
    run.git(consumer.parent.parent, 'commit', '-qm', 'change the consumer event discriminator')
    run.analyze('harness', 'updated')
    updated = run.sync('updated-group-sync')
    report = {'engine': owner_export['engine'], 'platform': platform.system() + '/' + platform.machine(),
              'node': subprocess.check_output(['node', '-v'], text=True).strip(),
              'metrics': run.metrics, 'cold_allocated_bytes': before, 'updated_allocated_bytes': run.disk(),
              'contracts': contracts, 'cold_cross_links': cold['crossLinks'], 'updated_cross_links': updated['crossLinks'],
              'group_impact': {k: impact[k] for k in ('summary', 'cross', 'truncated', 'outOfScope')},
              'sdk_only_impact': {k: scoped[k] for k in ('summary', 'cross', 'truncated', 'outOfScope')},
              'cold_indexes': cold_indexes, 'native_local_edges': local_evidence,
              'update_mode': next((line.strip() for line in (run.path / 'updated-harness.log').read_text().splitlines()
                                   if line.startswith('Incremental:')), 'incremental mode not reported')}
    dump(out / 'gitnexus-result.json', report)


if __name__ == '__main__':
    main()
