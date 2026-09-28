'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

let cachedResult = null;

function compile() {
  if (cachedResult) return cachedResult;
  const solc = require('solc');
  const src   = fs.readFileSync(path.join(__dirname, '../contracts/SecureGate.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'SecureGate.sol': { content: src } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi','evm.bytecode','evm.deployedBytecode'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter(e => e.severity === 'error');
    if (fatal.length) throw new Error(fatal.map(e => e.message).join('\n'));
  }
  const contract = output.contracts['SecureGate.sol']['SecureGate'];
  cachedResult = {
    abi:              contract.abi,
    bytecode:         '0x' + contract.evm.bytecode.object,
    deployedBytecode: '0x' + contract.evm.deployedBytecode.object
  };
  const artPath = path.join(__dirname, '../artifacts/SecureGate.json');
  const existing = JSON.parse(fs.readFileSync(artPath, 'utf8'));
  fs.writeFileSync(artPath, JSON.stringify({ ...existing, ...cachedResult }, null, 2));
  return cachedResult;
}

router.get('/', (req, res) => {
  try {
    const r = compile();
    res.json({ ok: true, abiEntries: r.abi.length, bytecodeBytes: (r.bytecode.length - 2) / 2, deployedBytecodeBytes: (r.deployedBytecode.length - 2) / 2 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.compile = compile;
