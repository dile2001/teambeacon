const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'teambeacon-backend'
  });
});

app.listen(PORT, () => {
  console.log(`TeamBeacon API running on port ${PORT}`);
});
