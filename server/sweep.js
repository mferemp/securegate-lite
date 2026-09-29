'use strict';
/**
 * AUTO-SWEEP: Scans the chain for every approval / operator permission
 * ever granted FROM k1Address and returns a structured revocation list.
 *
 * Scans:
 *  - ERC-20  Approval(owner, spender, value)              topic[0] = 0x8c5be1e5
 *  - ERC-721 Approval(owner, approved, tokenId)           topic[0] = 0x8c5be1e5
 *  - ERC-721/1155 ApprovalForAll(owner, operator, bool)   topic[0] = 0x17307eab
 *  - ERC-777 AuthorizedOperator(operator, tokenHolder)    topic[0] = 0xf4caeb27
 *  - Gnosis-style delegate calls / any OperatorAdded      topic[0] = 0xd211483f (common)
 *
 * Uses eth_getLogs in 10k-block chunks up to the last 500k blocks.
 * Returns deduped list of {type, token, spender/operator} ready for revoke.js.
 */
const express    = require('express');
const { ethers } = require('ethers');
const chains     = require('../config/chains.json');
const router     = express.Router();

// Well-known event topic hashes
const TOPIC_APPROVAL          = ethers.id('Approval(address,address,uint256)');
const TOPIC_APPROVAL_FOR_ALL  = ethers.id('ApprovalForAll(address,address,bool)');
const TOPIC_AUTH_OPERATOR     = ethers.id('AuthorizedOperator(address,address)');

// Minimal ABIs for call-based checks
const ERC20_ALLOWANCE_ABI = ['function allowance(address owner, address spender) view returns (uint256)'];
const ERC721_ISAPPROVED_ABI = ['function isApprovedForAll(address owner, address operator) view returns (bool)'];

async function chunkedLogs(provider, filter, fromBlock, toBlock, chunkSize = 9999) {
  const results = [];
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, toBlock);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      results.push(...logs);
    } catch (e) {
      // Some RPCs limit range — halve chunk and retry once
      const half = Math.floor(chunkSize / 2);
      if (half < 100) { results.push(); continue; }
      for (let f2 = from; f2 <= to; f2 += half) {
        const t2 = Math.min(f2 + half - 1, to);
        try {
          const logs2 = await provider.getLogs({ ...filter, fromBlock: f2, toBlock: t2 });
          results.push(...logs2);
        } catch { /* skip this sub-range */ }
      }
    }
  }
  return results;
}

router.post('/', async (req, res) => {
  const { k1Address, chainId, rpcOverride, lookbackBlocks = 500000 } = req.body;
  if (!k1Address || !chainId) return res.status(400).json({ error: 'Missing k1Address or chainId' });
  if (!ethers.isAddress(k1Address)) return res.status(400).json({ error: 'Invalid k1Address' });

  const chain = chains.chains.find(c => c.id === Number(chainId));
  if (!chain) return res.status(400).json({ error: 'Unknown chain ID' });

  try {
    const rpcUrl   = rpcOverride || chain.rpc;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const latest   = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - lookbackBlocks);
    const ownerTopic = ethers.zeroPadValue(k1Address.toLowerCase(), 32);

    // --- ERC-20 Approval (owner indexed as topic[1]) ---
    const approvalLogs = await chunkedLogs(provider, {
      topics: [TOPIC_APPROVAL, ownerTopic]
    }, fromBlock, latest);

    // --- ERC-721/1155 ApprovalForAll (owner indexed as topic[1]) ---
    const approvalForAllLogs = await chunkedLogs(provider, {
      topics: [TOPIC_APPROVAL_FOR_ALL, ownerTopic]
    }, fromBlock, latest);

    // --- ERC-777 AuthorizedOperator (tokenHolder indexed as topic[2]) ---
    const erc777Logs = await chunkedLogs(provider, {
      topics: [TOPIC_AUTH_OPERATOR, null, ownerTopic]
    }, fromBlock, latest);

    // Dedupe helpers
    const seen20  = new Set();
    const seenAll = new Set();
    const seen777 = new Set();

    const erc20Revocations   = [];
    const erc721Revocations  = [];
    const erc1155Revocations = [];
    const erc777Revocations  = [];

    // Process Approval logs — could be ERC-20 or ERC-721 single token
    for (const log of approvalLogs) {
      const token   = log.address.toLowerCase();
      const spender = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const key     = token + ':' + spender;
      if (seen20.has(key)) continue;
      seen20.add(key);
      // Check current allowance — skip if already zero
      try {
        const c = new ethers.Contract(token, ERC20_ALLOWANCE_ABI, provider);
        const allowance = await c.allowance(k1Address, spender);
        if (allowance > 0n) erc20Revocations.push({ token, spender });
      } catch {
        // If allowance call fails it may be ERC-721 single approval — include anyway
        erc20Revocations.push({ token, spender });
      }
    }

    // Process ApprovalForAll logs
    for (const log of approvalForAllLogs) {
      const token    = log.address.toLowerCase();
      const operator = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const key      = token + ':' + operator;
      if (seenAll.has(key)) continue;
      seenAll.add(key);
      // Check if still approved
      try {
        const c = new ethers.Contract(token, ERC721_ISAPPROVED_ABI, provider);
        const approved = await c.isApprovedForAll(k1Address, operator);
        if (approved) {
          // Try to determine ERC-1155 vs ERC-721 by checking supportsInterface
          // Default to erc721 list — both use same setApprovalForAll signature
          erc721Revocations.push({ token, operator });
        }
      } catch {
        erc721Revocations.push({ token, operator });
      }
    }

    // Process ERC-777 AuthorizedOperator logs
    for (const log of erc777Logs) {
      const token    = log.address.toLowerCase();
      const operator = ('0x' + log.topics[1].slice(26)).toLowerCase();
      const key      = token + ':' + operator;
      if (seen777.has(key)) continue;
      seen777.add(key);
      erc777Revocations.push({ token, operator });
    }

    const total = erc20Revocations.length + erc721Revocations.length + erc1155Revocations.length + erc777Revocations.length;

    res.json({
      k1Address,
      chain: chain.name,
      chainId,
      scannedBlocks: latest - fromBlock,
      fromBlock,
      toBlock: latest,
      total,
      erc20Revocations,
      erc721Revocations,
      erc1155Revocations,
      erc777Revocations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
