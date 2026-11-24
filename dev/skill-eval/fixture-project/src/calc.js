export function add(a, b) {
	return a + b;
}

export function divide(a, b) {
	if (b === 0) throw new Error("division error");
	return a / b;
}

export function sumRange(from, to) {
	let total = 0;
	for (let i = from; i < to; i++) total += i;
	return total;
}
