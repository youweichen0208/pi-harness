/** Native schema boundary: no model, filesystem or provider calls. */
import assert from 'node:assert/strict';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { ToolCallArgumentsStream } from '@earendil-works/pi-ai';
import { serializeMessage } from '../dist/server/serialize.js';
const parameters = Type.Object({
	name: Type.String({minLength:2,maxLength:8}),
	mode: Type.Union([Type.Literal('read'),Type.Literal('inspect')]),
	count: Type.Number(),
	items: Type.Array(Type.String()),
	note: Type.Optional(Type.String()),
	nullable: Type.Union([Type.Null(),Type.String()]),
});
const base = {name:'valid',mode:'read',count:2,items:['one'],nullable:null};
for (const schema of [parameters, JSON.parse(JSON.stringify(parameters))]) {
	const executed = [];
	const tool = {name:'fixture',label:'Fixture',description:'Schema fixture',parameters:schema,execute:async(_id,args)=>{
		executed.push(args); return {content:[{type:'text',text:'ok'}],details:{}};
	}};
	const options = {tools:[tool],context:{systemPrompt:'',messages:[],tools:[tool]},assistantMessage:{role:'assistant',content:[],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:0}};
	for (const args of [{...base,name:undefined},{...base,name:'x'},{...base,name:'too long name'},{...base,mode:'write'},{...base,count:{}},{...base,items:[{}]}]) {
		const result = await runToolCall({id:'invalid',type:'toolCall',name:'fixture',arguments:args},options);
		assert.equal(result.isError,true); assert.equal(executed.length,0,'invalid arguments never execute');
	}
	const args = {...base,count:'42',items:'one',note:null};
	const result = await runToolCall({id:'valid',type:'toolCall',name:'fixture',arguments:args},options);
	assert.equal(result.isError,false);
	assert.deepEqual(executed,[{...base,count:42}]);
	assert.equal(args.count,'42','transcript arguments are not mutated');
}
console.log('PASS Pi 1.5 TypeBox/plain JSON Schema validation, coercion and execution boundary');

const stream = new ToolCallArgumentsStream();
const payload = {code:'text("中文\\n");\n'.repeat(20000), nested:{items:[1,null,true]}};
const raw = JSON.stringify(payload);
let earlier, frozen;
for (let offset=0; offset<raw.length; offset+=137) {
	const partial = stream.append(raw.slice(offset,offset+137));
	if (!earlier) { earlier=partial; frozen=JSON.stringify(partial); }
}
assert.equal(JSON.stringify(earlier),frozen,'partial snapshots are immutable');
const complete = stream.finish(); assert.deepEqual(complete.arguments,payload); assert.equal(complete.argumentsError,undefined);
const card = serializeMessage({role:'assistant',timestamp:0,content:[{type:'toolCall',id:'large',name:'codemode',...complete}]},0);
assert.equal(card.content[0].argumentsTruncated,true);
assert(card.content[0].argumentsText.startsWith(raw.slice(0,1000)));
assert(card.content[0].argumentsText.length < raw.length, "wire preview remains bounded");
console.log('PASS large fragmented Unicode tool arguments and WebUI projection');
