import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/** One request per process. Protocol v1 uses bounded UTF-8 frames, never Java serialization. */
public final class PiJdbc {
	private static volatile Statement active;
	private static volatile Connection connection;
	private static volatile boolean cancelled;
	private static int inputBytes;
	private static String read(DataInputStream in) throws IOException {
		int n = in.readInt(); inputBytes += n;
		if (n < 0 || n > 262144 || inputBytes > 1048576) throw new IOException();
		byte[] bytes = new byte[n]; in.readFully(bytes); return new String(bytes, StandardCharsets.UTF_8);
	}
	private static void write(DataOutputStream out, String value) throws IOException {
		byte[] bytes = value.getBytes(StandardCharsets.UTF_8); out.writeInt(bytes.length); out.write(bytes);
	}
	private static int count(DataInputStream in, int max) throws IOException { int n = in.readInt(); if (n < 0 || n > max) throw new IOException(); return n; }
	private static void check() throws SQLException { if (cancelled) throw new SQLException("", "57014"); }
	private static void command(String sql) throws SQLException {
		check(); try (Statement s = connection.createStatement()) { active = s; s.setQueryTimeout(30); s.execute(sql); } finally { active = null; }
	}
	public static void main(String[] args) throws Exception {
		DataInputStream in = new DataInputStream(System.in);
		DataOutputStream out = new DataOutputStream(new FileOutputStream(FileDescriptor.out));
		// A driver writing to System.out must not corrupt the bridge protocol or disclose credentials.
		System.setOut(new PrintStream(new OutputStream() { public void write(int b) {} }));
		String stage = "JDBC_CONFIG_INVALID";
		try {
			if (in.readInt() != 0x50494a31) throw new IOException();
			int n = count(in, 32); if (n == 0) throw new IOException(); URL[] jars = new URL[n];
			for (int i = 0; i < n; i++) jars[i] = new File(read(in)).toURI().toURL();
			String className = read(in), url = read(in); Properties props = new Properties();
			n = count(in, 70); for (int i = 0; i < n; i++) props.setProperty(read(in), read(in));
			String sql = read(in); int limit = count(in, 1000);
			Thread cancel = new Thread(() -> {
				try { if (in.read() >= 0) { cancelled = true; Statement s = active; if (s != null) s.cancel(); Connection c = connection; if (c != null) c.close(); } } catch (Exception ignored) {}
			}); cancel.setDaemon(true); cancel.start();
			stage = "JDBC_DRIVER_LOAD_FAILED";
			try (URLClassLoader loader = new URLClassLoader(jars, Driver.class.getClassLoader())) {
				Thread.currentThread().setContextClassLoader(loader);
				Driver driver = (Driver) Class.forName(className, true, loader).getDeclaredConstructor().newInstance();
				stage = "JDBC_CONNECTION_FAILED"; check();
				connection = driver.connect(url, props);
				if (connection == null) throw new SQLException();
				try {
					stage = "JDBC_READONLY_REQUIRED";
					connection.setReadOnly(true);
					command("BEGIN READ ONLY");
					connection.setAutoCommit(false);
					try (Statement s = connection.createStatement()) {
						active = s; s.setQueryTimeout(30);
						try (ResultSet r = s.executeQuery("SHOW transaction_read_only")) {
							if (!r.next() || !Arrays.asList("on", "true", "1").contains(r.getString(1).toLowerCase(Locale.ROOT))) throw new SQLException();
						}
					} finally { active = null; }
					command("SET LOCAL search_path = pg_catalog, public");
					command("SET LOCAL statement_timeout = 30000");
					stage = "JDBC_QUERY_FAILED";
					try (Statement s = connection.createStatement()) {
						active = s; check(); s.setQueryTimeout(30); s.setMaxRows(limit + 1); s.setFetchSize(50);
						try (ResultSet result = s.executeQuery(sql)) {
							ResultSetMetaData meta = result.getMetaData(); int columns = meta.getColumnCount();
							if (columns > 1024) throw new SQLException();
							ByteArrayOutputStream header = new ByteArrayOutputStream(); DataOutputStream h = new DataOutputStream(header);
							h.writeInt(columns);
							for (int i = 1; i <= columns; i++) { String label = meta.getColumnLabel(i); if (label.length() > 4000) throw new SQLException(); write(h, label); }
							if (header.size() > 65536) throw new SQLException();
							ByteArrayOutputStream body = new ByteArrayOutputStream(); int rows = 0; boolean truncated = false;
							while (result.next()) {
								check(); if (rows >= limit) { truncated = true; break; }
								ByteArrayOutputStream rowBytes = new ByteArrayOutputStream(); DataOutputStream row = new DataOutputStream(rowBytes);
								for (int i = 1; i <= columns; i++) {
									int type = meta.getColumnType(i);
									if (type == Types.BOOLEAN || type == Types.BIT) { boolean v = result.getBoolean(i); row.writeInt(result.wasNull() ? 0 : v ? 2 : 3); }
									else if (type == Types.BINARY || type == Types.VARBINARY || type == Types.LONGVARBINARY || type == Types.BLOB) {
										try (InputStream stream = result.getBinaryStream(i)) { row.writeInt(stream == null ? 0 : 1); if (stream != null) write(row, "[binary]"); }
									} else {
										String value;
										if (type == Types.VARCHAR || type == Types.LONGVARCHAR || type == Types.CHAR || type == Types.CLOB || type == Types.NVARCHAR || type == Types.NCLOB) {
											try (Reader reader = result.getCharacterStream(i)) {
												if (reader == null) value = null;
												else { char[] chars = new char[4001]; int used = 0, got; while (used < chars.length && (got = reader.read(chars, used, chars.length - used)) > 0) used += got; value = new String(chars, 0, used); }
											}
										} else value = result.getString(i);
										row.writeInt(value == null ? 0 : 1);
										if (value != null) { if (value.length() > 4000) { value = value.substring(0, 4000); truncated = true; } write(row, value); }
									}
								}
								if (header.size() + body.size() + rowBytes.size() > 1500000) { truncated = true; break; }
								rowBytes.writeTo(body); rows++;
							}
							check(); out.writeInt(0x50494a31); out.writeInt(0); header.writeTo(out); out.writeInt(rows); body.writeTo(out); out.writeInt(truncated ? 1 : 0);
						}
					} finally { active = null; }
				} finally { try { connection.close(); } catch (Exception ignored) {} }
			}
		} catch (Throwable error) {
			String code = stage;
			if (!stage.equals("JDBC_READONLY_REQUIRED") && error instanceof SQLException) {
				String state = ((SQLException) error).getSQLState(); if (state != null && state.matches("[A-Z0-9]{5}")) code = "SQLSTATE_" + state;
			}
			out.writeInt(0x50494a31); out.writeInt(1); write(out, code);
		} finally { out.flush(); }
	}
}
