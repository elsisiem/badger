import { pool } from "../src/db";
import { runMigrations } from "../src/migrate";

await runMigrations();
await pool.end();
console.log("migrations ok");
