const path = require('node:path');
const fs = require('fs');

function sendWelcome(client, to) {
  const text = fs.readFileSync(path.join(__dirname, 'banner.txt'), 'utf8');
  return client.send('example.com', { to, subject: 'Welcome aboard', text });
}

module.exports = { sendWelcome };
