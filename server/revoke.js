'use strict';
const express    = require('express');
const { ethers } = require('ethers');
const chains     = require('../config/chains.json');
const router     = express.Router();

const ERC20_ABI   = ['function approve(address spender, uint256 amount) returns (bool)'];
const ERC721_ABI  = ['function setApprovalForAll(address operator, bool approved)'];
const ERC1155_ABI = ['function setApprovalForAll(address operator, bool approved)'];
const ERC777_ABI  = ['function revokeOperator(address operator)'];

router.post('/', async (req, res) => {
  const { k1Key, chainId, rpcOverride, erc20Revocations, erc721Revocations, erc1155Revocations, erc777Revocations } = req.body;
  if (!k1Key || !chainId) return res.status(400).json({ error: 'Missing k1Key or chainId' });
  const chain = chains.chains.find(c => c.id === Number(chainId));
  if (!chain) return res.status(400).json({ error: 'Unknown chain ID' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    const provider = new ethers.JsonRpcProvider(rpcOverride || chain.rpc);
    const signer   = new ethers.Wallet(k1Key, provider);
    const results  = [];
    let step = 0;

    const run = async (label, fn) => {
      step++;
      send({ step, status:'PENDING', message: label });
      try {
        const tx      = await fn();
        const receipt = await tx.wait(1);
        results.push({ label, txHash: receipt.hash, status:'REVOKED' });
        send({ step, status:'REVOKED', message: label + ' — tx: ' + receipt.hash });
      } catch(e) {
        results.push({ label, error: e.message, status:'FAILED' });
        send({ step, status:'FAILED', message: label + ' FAILED: ' + e.message });
      }
    };

    for (const { token, spender }  of (erc20Revocations   || [])) { const c = new ethers.Contract(token, ERC20_ABI,   signer); await run('ERC20 revoke ' + token + ' spender ' + spender,   () => c.approve(spender, 0n)); }
    for (const { token, operator } of (erc721Revocations  || [])) { const c = new ethers.Contract(token, ERC721_ABI,  signer); await run('ERC721 setApprovalForAll false ' + token,            () => c.setApprovalForAll(operator, false)); }
    for (const { token, operator } of (erc1155Revocations || [])) { const c = new ethers.Contract(token, ERC1155_ABI, signer); await run('ERC1155 setApprovalForAll false ' + token,           () => c.setApprovalForAll(operator, false)); }
    for (const { token, operator } of (erc777Revocations  || [])) { const c = new ethers.Contract(token, ERC777_ABI,  signer); await run('ERC777 revokeOperator ' + operator + ' on ' + token, () => c.revokeOperator(operator)); }

    const failed = results.filter(r => r.status === 'FAILED');
    send({ status: failed.length === 0 ? 'COMPLETE' : 'PARTIAL', message: (results.length - failed.length) + '/' + results.length + ' revocations succeeded.', results });
    res.end();
  } catch(err) {
    res.write(JSON.stringify({ status:'ERROR', message: err.message }) + '\n');
    res.end();
  }
});

module.exports = router;
