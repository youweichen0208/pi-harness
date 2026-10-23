// Run with node --import tsx; uses isolated temporary JDT workspaces, no model calls.
import assert from 'node:assert/strict';
import { JavaLanguageSession } from '../server/playground-java-language.ts';
const home = process.env.PI_WEB_JDTLS_HOME;
if (!home) throw new Error('Set PI_WEB_JDTLS_HOME to an installed Eclipse JDT LS distribution');
const session = new JavaLanguageSession(home, process.env);
try {
	const code = 'import java.util.*; public class Solution { int f(){ Map<Integer,Integer> map=new HashMap<>(); map. return 1; } }';
	const result = await session.analyze(code, code.indexOf('map. ') + 4, 'completion');
	assert(result.items.some(i => i.label.startsWith('put(')));
	assert(result.items.some(i => i.label.startsWith('containsKey(')));
	assert(!result.items.some(i => i.label === 'abstract'));
	const signature = code.replace('map. ', 'map.put(1, ');
	assert((await session.analyze(signature, signature.indexOf('map.put(1, ') + 11, 'signature')).signatures.some(s => s.includes('put(')));
	const broken = 'public class Solution { int f(){ return "wrong"; } }';
	const diagnostics = await session.analyze(broken, 0, 'diagnostics');
	assert(diagnostics.diagnostics.some(d => d.severity === 'error' && /String|int/.test(d.message)));
	const fragment = 'import java.util.*;\nint f(Map<String,Integer> map){ map. return 1; }';
	assert((await session.analyze(fragment, fragment.indexOf('map. ') + 4, 'completion')).items.some(i => i.label.startsWith('get(')));
	const importing = 'public class Solution { ArrayL }';
	const imports = await session.analyze(importing, importing.indexOf('ArrayL') + 6, 'completion');
	assert(imports.items.some(i => i.label.includes('ArrayList') && i.additionalEdits.some(e => e.text.includes('import java.util.ArrayList'))));
	console.log('PASS: actual JDT LS member completions, generics, signatures, diagnostics, method fragments');
} finally { await session.close(); }
