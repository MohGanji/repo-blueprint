const express = require('express');
const { listUsers } = require('./routes/users');
const { sendWelcome } = require('./mailer');
require('./missing');
require('./banner.txt');

const app = express();
app.get('/users', listUsers);
app.post('/welcome', (req, res) => res.json(sendWelcome(req.mail, req.body.to)));
if (process.env.PLUGIN) require(process.env.PLUGIN);
app.listen(3000);
