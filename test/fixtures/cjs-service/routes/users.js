const { Router } = require('express');
const db = require('../db');

function listUsers(req, res) {
  res.json(db.all());
}

module.exports = { listUsers };

module.exports.router = Router();
