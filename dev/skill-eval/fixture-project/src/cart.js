export function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function applyDiscount(amount, percentOff) {
	return amount * (percentOff / 100);
}
