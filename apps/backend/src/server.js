const express = require('express');
const { pool, resilientQuery, getCircuitState, checkDatabaseReadiness } = require('./db');
const crypto = require('crypto');
const client = require('prom-client');
const { createClient } = require('redis');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('./middleware/auth');
const { requireRole } = require('./middleware/authorize');
const bcrypt = require('bcrypt');
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required');
  process.exit(1);
}
const redisPublisher = createClient({
  url: 'redis://redis:6379'
})
const redisSubscriber = redisPublisher.duplicate()
redisPublisher.on('error', (err) => {
  console.error('Redis error:', err)
})
redisSubscriber.on('error', (err) => {
  console.error('Redis subscriber error:', err)
})
const app = express();
app.use(express.json());
const sseClients = new Set()
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
const realtimeHealthGauge = new client.Gauge({

  name: 'teambeacon_realtime_healthy',

  help: 'Whether TeamBeacon realtime messaging is healthy (1 = healthy, 0 = degraded)'

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
app.get('/health/live', (req, res) => {
  res.json({
    status: 'ok',
    service: 'teambeacon-backend',
  });
});
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
app.get('/health/ready', async (req, res) => {
  const isReady = await checkDatabaseReadiness();

  if (!isReady) {
    return res.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
    });
  }

  res.json({
    status: 'ready',
    database: 'connected',
  });
});
const apiRouter = express.Router();
apiRouter.get('/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});
apiRouter.post(
  '/auth/admin-test',
  authenticateToken,
  requireRole('admin'),
  (req, res) => {
    res.json({
      message: 'Admin access granted'
    });
  }
);
apiRouter.get('/health/realtime', (req, res) => {

  const healthy = redisPublisher.isReady && redisSubscriber.isReady

  res.json({
    status: healthy ? 'healthy' : 'degraded',
    publisherReady: redisPublisher.isReady,
    subscriberReady: redisSubscriber.isReady,
    sseClients: sseClients.size
  })

})
apiRouter.get('/messages', async (req, res) => {
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
apiRouter.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: 'Username and password are required'
    });
  }
  try {
    const result = await pool.query(
      `SELECT id, username, password_hash, role
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Invalid username or password'
      });
    }

    const user = result.rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: 'Invalid username or password'
      });
    }
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    return res.json({ token });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});
apiRouter.post('/messages', async (req, res) => {
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

apiRouter.get('/teams', async (req, res) => {
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
apiRouter.post(
  '/teams',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    let team = {};
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
      team = result.rows[0];
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          status: 'error',
          message: 'Team already exists'
        });
      }

      console.error('Failed to create team:', error);

      return res.status(500).json({
        status: 'error',
        message: 'Failed to create team'
      });
    }
    try {
      console.log('Publishing team.created to Redis')
      const event = {
        type: 'team.created',
        data: team
      }
      await redisPublisher.publish(
        'teambeacon-events',
        JSON.stringify(event)
      )
    } catch (error) {
      console.error('Failed to publish team.created event:', error)
    }
    res.status(201).json(team);
  });
apiRouter.get('/members', async (req, res) => {
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
apiRouter.post('/members', async (req, res) => {
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

apiRouter.get('/metrics', async (req, res) => {
  const realtimeHealthy =
    redisPublisher.isReady && redisSubscriber.isReady

  realtimeHealthGauge.set(realtimeHealthy ? 1 : 0)
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
apiRouter.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  res.write('data: connected\n\n')
  sseClients.add(res)
  console.log('SSE client connected. Total:', sseClients.size)
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
    console.log('SSE client disconnected. Total:', sseClients.size)
  })
  //res.send() → sends response → closes connection
  //res.write() → sends some data → keeps connection open
  //And SSE requires every message to finish with two newlines:
  //data: connected\n\n
})
redisPublisher.on('ready', () => {
  console.log('Redis publisher READY')
  console.log('Publisher isOpen:', redisPublisher.isOpen)
  console.log('Publisher isReady:', redisPublisher.isReady)
})
redisPublisher.on('reconnecting', () => {
  console.log('Redis publisher RECONNECTING')
  console.log('reconnecting Publisher isOpen:', redisPublisher.isOpen)
  console.log('reconnecting Publisher isReady:', redisPublisher.isReady)
})

redisPublisher.on('end', () => {
  console.log('Redis publisher END')
})
redisSubscriber.on('ready', () => {
  console.log('Redis subscriber READY')
  console.log('Subscriber isOpen:', redisSubscriber.isOpen)
  console.log('Subscriber isReady:', redisSubscriber.isReady)
})

redisSubscriber.on('reconnecting', () => {
  console.log('Redis subscriber RECONNECTING')
  console.log('reconnecting Subscriber isOpen:', redisSubscriber.isOpen)
  console.log('reconnecting Subscriber isReady:', redisSubscriber.isReady)
})

redisSubscriber.on('end', () => {
  console.log('Redis subscriber END')
})
app.use('/api', apiRouter);
let server;
async function startServer() {

  server = app.listen(PORT, () => {
    console.log(`TeamBeacon backend running on port ${PORT}`);
  });
  try {

    await redisPublisher.connect()
    await redisSubscriber.connect()
    console.log('Connected Redis publisher and subscriber')
    await redisSubscriber.subscribe('teambeacon-events', (message) => {

      console.log(
        'Redis event received. Local SSE clients:',
        sseClients.size
      )
      sseClients.forEach((client) => {
        client.write(`data: ${message}\n\n`)
      })
    })
    console.log('Redis subscriber SUBSCRIBED to teambeacon-events')
  } catch (error) {
    console.error('Failed to connect Redis publisher or subscriber:', error)
  }
}
let isShuttingDown = false;
const gracefulShutdown = (signal) => {
  if (isShuttingDown) {
    console.log(`Shutdown already in progress. Ignoring ${signal}.`);
    return;
  }

  isShuttingDown = true;

  console.log(`${signal} received.Starting graceful shutdown...`);
  console.log(`Active requests at shutdown: ${activeRequests}`);

  const shutdownTimeout = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10000);
  console.log(`Closing ${sseClients.size} SSE clients...`);

  sseClients.forEach((client) => {
    client.end()
  })

  sseClients.clear()
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed.');

      await pool.end();
      console.log('PostgreSQL pool closed.');

      if (redisSubscriber.isOpen) {
        await redisSubscriber.quit();
        console.log('Redis subscriber closed.');
      }

      if (redisPublisher.isOpen) {
        await redisPublisher.quit();
        console.log('Redis publisher closed.');
      }

      clearTimeout(shutdownTimeout);

      console.log('Graceful shutdown complete.');
      process.exit(0);
    });
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});