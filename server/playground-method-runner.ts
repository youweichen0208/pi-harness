import type { PlaygroundCase, PlaygroundMethod } from "./protocol.js";
import { reflectionType, valueLiteral } from "./playground-methods.js";

/** Internal source is compiled beside the single user source, never saved to it. */
export function methodRunnerSource(name: string, method: PlaygroundMethod, cases: PlaygroundCase[], maxBytes: number): string {
	const packageName = method.className.includes(".") ? method.className.slice(0, method.className.lastIndexOf(".")) : "";
	const arms = cases.map((test, index) => `case ${index}: {
		java.lang.reflect.Method method = target.getDeclaredMethod("${method.name}", new Class<?>[]{${method.parameters.map(p => `${reflectionType(p.type)}.class`).join(",")}});
		Object instance = ${method.isStatic ? "null" : "target.getDeclaredConstructor().newInstance()"};
		Object actual = method.invoke(instance, new Object[]{${method.parameters.map((p, i) => valueLiteral(p.type, test.args[i])).join(",")}});
		Object expected = ${test.expected ? valueLiteral(method.returnType, test.expected) : "null"};
		status = ${test.expected ? 'java.util.Objects.deepEquals(actual, expected) ? "passed" : "failed"' : '"unasserted"'};
		actualText = ${method.returnType === "void" ? '"void"' : "render(actual)"};
		expectedText = ${test.expected ? "render(expected)" : '""'};
		break;
	}`).join("\n");
	return `${packageName ? `package ${packageName};` : ""}
public class ${name} {
	static final int LIMIT = ${maxBytes};
	static class OutputLimit extends RuntimeException {}
	static void append(StringBuilder out, String value) {
		if ((long)out.length() + value.length() > LIMIT) throw new OutputLimit();
		out.append(value);
	}
	static void renderInto(StringBuilder out, Object value) {
		if (value == null) { append(out, "null"); return; }
		if (value.getClass().isArray()) {
			append(out, "[");
			for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) {
				if (i > 0) append(out, ", ");
				renderInto(out, java.lang.reflect.Array.get(value, i));
			}
			append(out, "]");
		} else if (value instanceof java.util.List<?>) {
			append(out, "[");
			boolean first = true;
			for (Object item : (java.util.List<?>)value) {
				if (!first) append(out, ", ");
				first = false;
				renderInto(out, item);
			}
			append(out, "]");
		} else if (value instanceof String || value instanceof Character) {
			append(out, "\\\"");
			String text = value.toString();
			for (int i = 0; i < text.length(); i++) {
				char ch = text.charAt(i);
				if (ch == '"' || ch == '\\\\') append(out, "\\\\" + ch);
				else if (ch < 32 || Character.isSurrogate(ch)) append(out, String.format("\\\\u%04x", (int)ch));
				else append(out, String.valueOf(ch));
			}
			append(out, "\\\"");
		} else append(out, String.valueOf(value));
	}
	static String render(Object value) { StringBuilder out = new StringBuilder(); renderInto(out, value); return out.toString(); }
	static String encode(String text) { return java.util.Base64.getEncoder().encodeToString(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
	public static void main(String[] args) throws Exception {
		String status = "error", actualText = "", expectedText = "", error = "";
		try {
			Class<?> target = Class.forName("${method.className}");
			switch (Integer.parseInt(args[0])) { ${arms} default: throw new IllegalArgumentException("Unknown case"); }
		} catch (Throwable cause) {
			if (cause instanceof java.lang.reflect.InvocationTargetException && cause.getCause() != null) cause = cause.getCause();
			if (cause instanceof OutputLimit) { status = "overflow"; }
			else { status = "error"; error = cause.getClass().getName() + ": " + cause.getMessage(); }
		}
		String result;
		if ((long)actualText.length() + expectedText.length() + error.length() > LIMIT) result = "overflow";
		else result = status + "\\n" + encode(actualText) + "\\n" + encode(expectedText) + "\\n" + encode(error);
		byte[] bytes = result.getBytes(java.nio.charset.StandardCharsets.UTF_8);
		if (bytes.length > LIMIT) bytes = "overflow".getBytes(java.nio.charset.StandardCharsets.UTF_8);
		java.nio.file.Files.write(java.nio.file.Paths.get(args[1]), bytes);
	}
}
`;
}
