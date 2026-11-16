/** Reconstruct product state in protocol tests without assuming full snapshots. */
export function mergeSnapshot(previous, message) {
	if (message.type === 'snapshot') return message.state;
	if (message.type !== 'snapshot_delta') return previous;
	if (!previous || previous.conversationId !== message.conversationId || previous.rev !== message.baseRev) throw Error('Snapshot revision gap; a full resync is required');
	if ('messages' in message.state || !Array.isArray(message.appended)) throw Error('Invalid snapshot delta');
	return { ...message.state, messages: [...previous.messages, ...message.appended] };
}

export function snapshotStates(events) {
	const states = [];
	let state;
	for (const event of events) {
		const next = mergeSnapshot(state, event);
		if (next !== state) states.push(next);
		state = next;
	}
	return states;
}
