import mysql from "mysql2/promise";

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_CONNECTION_LIMIT,
} = process.env;

export const pool = mysql.createPool({
  host: DB_HOST || "localhost",
  port: Number(DB_PORT || 3307),
  user: DB_USER || "root",
  password: DB_PASSWORD ?? "",
  database: DB_NAME || "andyfers",
  waitForConnections: true,
  connectionLimit: Number(DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: "utf8mb4",
  decimalNumbers: true,
});

export async function testDbConnection() {
  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows?.[0]?.ok === 1;
}