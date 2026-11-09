package fixture;
import java.io.*;
import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;

/** No network: exercises the real driver loader, JDBC calls and cancellation thread. */
public class GaussDriver implements Driver {
	static Object proxy(Class<?> type, InvocationHandler handler) { return Proxy.newProxyInstance(GaussDriver.class.getClassLoader(), new Class<?>[]{type}, handler); }
	static Object defaultValue(Class<?> type) { if (type == boolean.class) return false; if (type == int.class) return 0; if (type == long.class) return 0L; return null; }
	public Connection connect(String url, Properties properties) throws SQLException {
		System.out.println("driver-log-secret:" + properties.getProperty("password"));
		if (url.contains("authfail")) throw new SQLException("secret password SQL", "28P01");
		if (!"true".equals(properties.getProperty("allowReadOnly"))) throw new SQLException("read only property missing");
		final boolean[] begun = {false}, cancel = {false};
		return (Connection) proxy(Connection.class, (c, method, args) -> {
			String m = method.getName();
			if (m.equals("close")) { cancel[0] = true; return null; }
			if (m.equals("createStatement")) return proxy(Statement.class, (s, sm, sa) -> {
				String sn = sm.getName();
				if (sn.equals("cancel")) { cancel[0] = true; return null; }
				if (sn.equals("execute")) {
					if (sa[0].equals("BEGIN READ ONLY")) begun[0] = true;
					return false;
				}
				if (sn.equals("executeQuery")) {
					String sql = (String) sa[0];
					if (!begun[0]) throw new SQLException("transaction missing");
					if (sql.equals("SHOW transaction_read_only")) return rows(new String[]{"transaction_read_only"}, new int[]{Types.VARCHAR}, new String[][]{{url.contains("writable") ? "off" : "on"}});
					if (sql.contains("hang")) { while (!cancel[0]) Thread.sleep(10); throw new SQLException("cancelled", "57014"); }
					if (sql.contains("pg_matviews") && !url.contains("modern")) throw new SQLException("relation PG_MATVIEWS does not exist", "42P01");
					if (sql.contains("information_schema.tables")) return rows(new String[]{"schema", "name", "kind"}, new int[]{Types.VARCHAR, Types.VARCHAR, Types.VARCHAR}, new String[][]{{"CORE", "orders", "BASE TABLE"}});
					if (sql.contains("badquery")) throw new SQLException("secret SQL", "42601");
					if (sql.contains("many")) { String[][] values = new String[1001][1]; for (int i = 0; i < values.length; i++) values[i][0] = String.valueOf(i); return rows(new String[]{"n"}, new int[]{Types.BIGINT}, values); }
					if (sql.contains("longtext")) { char[] chars = new char[4500]; Arrays.fill(chars, '文'); return rows(new String[]{"text"}, new int[]{Types.VARCHAR}, new String[][]{{new String(chars)}}); }
					return rows(new String[]{"big", "decimal", "null", "flag"}, new int[]{Types.BIGINT, Types.NUMERIC, Types.VARCHAR, Types.BOOLEAN}, new String[][]{{"9223372036854775807", "1234567890.123456789", null, "true"}});
				}
				return defaultValue(sm.getReturnType());
			});
			return defaultValue(method.getReturnType());
		});
	}
	static ResultSet rows(String[] names, int[] types, String[][] values) {
		final int[] index = {-1}; final boolean[] wasNull = {false};
		return (ResultSet) proxy(ResultSet.class, (p, m, args) -> {
			switch (m.getName()) {
				case "next": return ++index[0] < values.length;
				case "wasNull": return wasNull[0];
				case "getMetaData": return proxy(ResultSetMetaData.class, (mp, mm, ma) -> {
					if (mm.getName().equals("getColumnCount")) return names.length;
					if (mm.getName().equals("getColumnLabel")) return names[(int) ma[0] - 1];
					if (mm.getName().equals("getColumnType")) return types[(int) ma[0] - 1];
					return defaultValue(mm.getReturnType());
				});
				case "getString": case "getBoolean": case "getCharacterStream": {
					String value = values[index[0]][(int) args[0] - 1]; wasNull[0] = value == null;
					if (m.getName().equals("getBoolean")) return Boolean.parseBoolean(value);
					if (m.getName().equals("getCharacterStream")) return value == null ? null : new StringReader(value);
					return value;
				}
				default: return defaultValue(m.getReturnType());
			}
		});
	}
	public boolean acceptsURL(String url) { return true; }
	public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
	public int getMajorVersion() { return 1; } public int getMinorVersion() { return 0; }
	public boolean jdbcCompliant() { return false; } public Logger getParentLogger() { return Logger.getGlobal(); }
}
