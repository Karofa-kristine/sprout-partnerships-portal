'use strict';

// Vercel serverless entry point. server.js exports the configured Express app
// (an Express app is itself a (req, res) handler), so Vercel can invoke it
// directly for every route. All routing/auth/static handling stays in the app.
module.exports = require('../server.js');
