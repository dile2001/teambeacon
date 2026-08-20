const express = require('express');
const pool = require('./db');

const app = express();
app.use(express.json());
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


app.listen(PORT, () => {
  console.log(`TeamBeacon backend running on port ${PORT}`);
});
