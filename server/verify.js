'use strict';
const express    = require('express');
const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
const chains     = require('../config/chains.json');
const router     = express.Router();

function loadArtifact() {
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts/SecureGate.json'), 'utf8'));
  return { abi: art.abi || [], deployedBytecode: art.deployedBytecode || null };
}

router.post('/', async (req, res) => {
  const { contractAddress, k1Address, k2Address, k3Address, chainId, rpcOverride } = req.body;
  if (!contractAddress || !k1Address || !k2Address || !k3Address || !chainId)
    return res.status(400).json({ error: 'Missing required fields' });

  const chain = chains.chains.find(c => c.id === Number(chainId));
  if (!chain) return res.status(400).json({ error: 'Unknown chain ID' });

  const checks = [];
  const result = (name, pass, detail) => checks.push({ name, pass, detail });

  try {
    const { abi, deployedBytecode } = loadArtifact();
    const provider = new ethers.JsonRpcProvider(rpcOverride || chain.rpc);
    const contract = new ethers.Contract(contractAddress, abi, provider);

    const onChainCode = await provider.getCode(contractAddress);
    result('Contract exists at address', onChainCode !== '0x', 'Code length: ' + onChainCode.length);

    if (deployedBytecode) {
      const strip = hex => hex.startsWith('0x') ? hex.slice(0, -106) : hex.slice(0, -106);
      result('Bytecode matches audited artifact', strip(deployedBytecode).toLowerCase() === strip(onChainCode).toLowerCase(), 'Metadata-stripped comparison');
    } else {
      result('Bytecode check', false, 'deployedBytecode not in artifact — compile first');
    }

    const onK1 = await contract.K1();
    const onK2 = await contract.K2();
    const onK3 = await contract.K3();
    const onChainId = await contract.GATE_CHAIN_ID();

    result('K1 matches input', onK1.toLowerCase() === k1Address.toLowerCase(), 'On-chain: ' + onK1);
    result('K2 matches input', onK2.toLowerCase() === k2Address.toLowerCase(), 'On-chain: ' + onK2);
    result('K3 matches input', onK3.toLowerCase() === k3Address.toLowerCase(), 'On-chain: ' + onK3);
    result('K1/K2/K3 all distinct', new Set([onK1,onK2,onK3].map(a=>a.toLowerCase())).size === 3, 'All three addresses are unique');
    result('GATE_CHAIN_ID matches selected chain', Number(onChainId) === Number(chainId), 'On-chain: ' + onChainId.toString() + ', expected: ' + chainId);

    try {
      const randomHash = ethers.id('test-' + Date.now());
      const intent = await contract.intents(randomHash);
      result('No phantom pre-authorized intents', !intent.exists, 'Random intentHash is uninitialized');
    } catch(e) { result('Intent slot check', false, e.message); }

    const passed = checks.filter(c => c.pass).length;
    const failed = checks.filter(c => !c.pass).length;
    res.json({ contractAddress, chain: chain.name, chainId, checks, summary: { passed, failed, total: checks.length, verdict: failed === 0 ? 'HARDENED — All checks passed' : 'ATTENTION — ' + failed + ' check(s) failed' } });
  } catch(err) {
    res.status(500).json({ error: err.message, checks });
  }
});

module.exports = router;
