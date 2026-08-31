const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 2000,
});
let circuitState = 'CLOSED';
let failureCount = 0;
let circuitOpenedAt = null;
const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 10000;

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
async function resilientQuery(text, params) {
  if (circuitState === 'HALF_OPEN') {
    throw new Error('Database circuit breaker is HALF_OPEN');
  }
  if (circuitState === 'OPEN') {
    const timeSinceOpened = Date.now() - circuitOpenedAt;

    if (timeSinceOpened < RECOVERY_TIMEOUT_MS) {
      throw new Error('Database circuit breaker is OPEN');
    }

    circuitState = 'HALF_OPEN';
    console.log('Database circuit breaker is HALF_OPEN.');
  }
  try {
    const result = await queryWithRetry(text, params);
    if (circuitState === 'HALF_OPEN') {
      console.log('Database circuit breaker CLOSED.');
    }
    failureCount = 0;
    circuitState = 'CLOSED';
    return result;
  } catch (err) {
    failureCount++;
    console.error(
      `Database operation failed. Circuit failure count: ${failureCount}`
    );
    if (circuitState === 'HALF_OPEN') {
      circuitState = 'OPEN';
      circuitOpenedAt = Date.now();
      console.error('Database circuit breaker REOPENED.');
    } else if (failureCount >= FAILURE_THRESHOLD) {
      circuitState = 'OPEN';
      circuitOpenedAt = Date.now();

      console.error('Database circuit breaker OPENED.');
    }
    throw err;
  }
}
module.exports = { pool, queryWithRetry, resilientQuery };
