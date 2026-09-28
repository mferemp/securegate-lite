'use strict';
const express = require('express');
const chains  = require('../config/chains.json');
const router  = express.Router();
router.get('/', (_req, res) => res.json(chains.chains));
module.exports = router;
