const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 2000,
});
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});
function isRetryableError(err) {
  return (
    err.message?.includes('connection timeout') ||
    err.message?.includes('Connection terminated') ||
    err.cause?.message?.includes('Connection terminated unexpectedly')
  );
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function queryWithRetry(text, params, maxAttempts = 3) {
  let attempt = 1;

  while (attempt <= maxAttempts) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      console.error(`Database query attempt ${attempt} failed:`, err.message);

      if (!isRetryableError(err)) {
        throw err;
      }

      if (attempt === maxAttempts) {
        throw err;
      }
      const baseDelay = 200 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 100;
      const delay = baseDelay + jitter;
      console.log(`Retrying database query in ${Math.round(delay)}ms...`);

      await sleep(delay);
      attempt++;
    }
  }
}
module.exports = { pool, queryWithRetry };
