'use strict';
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');

const deployRouter  = require('./deploy');
const revokeRouter  = require('./revoke');
const gasRouter     = require('./gas');
const verifyRouter  = require('./verify');
const compileRouter = require('./compile');
const sweepRouter   = require('./sweep');
const chainsRouter  = require('./chains');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: 'http://localhost:' + PORT }));
app.use(bodyParser.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/deploy',  deployRouter);
app.use('/api/revoke',  revokeRouter);
app.use('/api/gas',     gasRouter);
app.use('/api/verify',  verifyRouter);
app.use('/api/compile', compileRouter);
app.use('/api/sweep',   sweepRouter);
app.use('/api/chains',  chainsRouter);

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  SecureGate Lite v2 — Operator Dashboard    ║');
  console.log('║  http://localhost:' + PORT + '                      ║');
  console.log('║  PRIVATE — localhost only                    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});

module.exports = app;
