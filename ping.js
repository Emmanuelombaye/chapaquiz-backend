const https = require('https');
const http = require('http');

// Replace this URL with your deployed Render backend URL
const BACKEND_URL = process.env.BACKEND_URL || 'https://your-chapaquiz-backend.onrender.com/api/admin/stats';
const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function pingServer() {
  const client = BACKEND_URL.startsWith('https') ? https : http;
  
  console.log(`[${new Date().toISOString()}] Sending keep-alive ping to: ${BACKEND_URL}...`);
  
  client.get(BACKEND_URL, (res) => {
    console.log(`[${new Date().toISOString()}] Ping response code: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Ping failed:`, err.message);
  });
}

// Ping immediately on start
pingServer();

// Repeat every 10 minutes
setInterval(pingServer, PING_INTERVAL_MS);
