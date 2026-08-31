const express = require('express');
const { pool, resilientQuery } = require('./db');
const crypto = require('crypto');
const client = require('prom-client');
const app = express();
app.use(express.json());
const httpRequestCounter = new client.Counter({
  name: 'teambeacon_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status']
});
const httpRequestDuration = new client.Histogram({
  name: 'teambeacon_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});
let activeRequests = 0;
const httpRequestsInFlight = new client.Gauge({
  name: 'teambeacon_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed'
});
app.use((req, res, next) => {
  activeRequests++;
  httpRequestsInFlight.inc();
  let inFlightCompleted = false;

  const completeInFlightRequest = () => {
    if (inFlightCompleted) return;

    inFlightCompleted = true;
    httpRequestsInFlight.dec();
    activeRequests--;
  };
  const start = Date.now();
  const request_id = req.get('X-Request-Id') || crypto.randomUUID();

  req.requestId = request_id;
  res.setHeader('X-Request-Id', request_id);
  res.on('finish', () => {
    completeInFlightRequest();
    const level = res.statusCode >= 500 ? 'error' : 'info';
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      request_id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration
    }));
    httpRequestCounter.inc({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode
    });
    httpRequestDuration.observe(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode
      },
      duration / 1000
    );
  });
  res.on('close', () => {
    completeInFlightRequest();
  });
  next();
});

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'teambeacon-backend'
  });
});
app.get('/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      status: 'ok',
      database: 'connected',
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error('Database health check failed:', error);

    res.status(500).json({
      status: 'error',
      database: 'disconnected',
    });
  }
});
app.get('/messages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM messages'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Failed to get messages:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to get messages'
    });
  }
});
app.post('/messages', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        status: 'error',
        message: 'Message is required'
      });
    }
    const result = await pool.query(
      'INSERT INTO messages (message) VALUES ($1) RETURNING *',
      [message]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Failed to create message:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to create message'
    });
  }
});

app.get('/teams', async (req, res) => {
  try {
    const result = await resilientQuery(
      'SELECT * FROM teams ORDER BY id'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Failed to get teams:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to get teams'
    });
  }
});
app.post('/teams', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        status: 'error',
        message: 'Team name is required'
      });
    }

    const result = await pool.query(
      'INSERT INTO teams (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        status: 'error',
        message: 'Team already exists'
      });
    }

    console.error('Failed to create team:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to create team'
    });
  }
});
app.get('/members', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        members.id,
        members.name,
        members.team_id,
        teams.name AS team_name,
        members.created_at
      FROM members
      JOIN teams
        ON members.team_id = teams.id
      ORDER BY members.id
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Failed to get members:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to get members'
    });
  }
});
app.post('/members', async (req, res) => {
  try {
    const { name, team_id } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        status: 'error',
        message: 'Member name is required'
      });
    }

    if (!Number.isInteger(team_id)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid team_id is required'
      });
    }

    const result = await pool.query(
      `INSERT INTO members (name, team_id)
       VALUES ($1, $2)
       RETURNING *`,
      [name.trim(), team_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({
        status: 'error',
        message: 'Team does not exist'
      });
    }

    console.error('Failed to create member:', error);

    res.status(500).json({
      status: 'error',
      message: 'Failed to create member'
    });
  }
});
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
app.post('/alerts', (req, res) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'alert',
      event: 'alertmanager_webhook',
      payload: req.body,
    })
  );

  res.sendStatus(200);
});

const server = app.listen(PORT, () => {
  console.log(`TeamBeacon backend running on port ${PORT}`);
});
const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Starting graceful shutdown...`);
  console.log(`Active requests at shutdown: ${activeRequests}`);

  const shutdownTimeout = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10000);
  server.close(async () => {
    console.log('HTTP server closed.');

    await pool.end();
    console.log('PostgreSQL pool closed.');

    clearTimeout(shutdownTimeout);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
