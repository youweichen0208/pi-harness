import test from "node:test";
import assert from "node:assert/strict";
import { add, divide } from "../src/calc.js";

test("add", () => {
	assert.equal(add(1, 2), 3);
});

test("divide", () => {
	assert.equal(divide(6, 3), 2);
});
