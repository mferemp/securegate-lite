'use strict';
const express      = require('express');
const { ethers }   = require('ethers');
const fs           = require('fs');
const path         = require('path');
const chains       = require('../config/chains.json');
const { compile }  = require('./compile');
const router       = express.Router();

function loadArtifact() {
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts/SecureGate.json'), 'utf8'));
  if (!art.bytecode || art.bytecode === '' || art.bytecode === '0x') {
    const fresh = compile();
    art.abi = fresh.abi; art.bytecode = fresh.bytecode; art.deployedBytecode = fresh.deployedBytecode;
  }
  if (!art.abi || !art.bytecode || art.bytecode === '0x')
    throw new Error('Artifact has no bytecode. Compile step must run first.');
  return art;
}

// Flashbots relay URL per chain (null = use standard RPC)
const FLASHBOTS_RELAY = {
  1:    'https://relay.flashbots.net',
  5:    'https://relay-goerli.flashbots.net',
  11155111: null  // Sepolia — no Flashbots relay; use RPC
};

/**
 * Attempt deploy up to maxAttempts times.
 * On Ethereum mainnet, tries Flashbots relay first, falls back to standard RPC.
 */
async function deployWithRetry(abi, bytecode, deployer, provider, k1Address, k2Address, k3Address, opts, chainId, rpcUrl, send, maxAttempts = 3) {
  let lastErr;
  const useFlashbots = FLASHBOTS_RELAY[chainId] !== undefined && FLASHBOTS_RELAY[chainId] !== null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let txProvider = provider;
      let txSigner   = deployer;

      if (useFlashbots && attempt === 1) {
        send({ pct: 36, status: 'FLASHBOTS', message: 'Attempt ' + attempt + '/' + maxAttempts + ' — broadcasting via Flashbots relay...' });
        // For Flashbots: we use the standard provider but set custom headers via a wrapped fetch
        // ethers v6 doesn’t natively support Flashbots bundle submission, so we do direct RPC
        // and rely on the mev-share compatible relay accepting eth_sendRawTransaction
        const fbProvider = new ethers.JsonRpcProvider(FLASHBOTS_RELAY[chainId]);
        txProvider = fbProvider;
        txSigner   = deployer.connect(fbProvider);
      } else {
        send({ pct: 36, status: 'DEPLOYING', message: 'Attempt ' + attempt + '/' + maxAttempts + ' — broadcasting via standard RPC...' });
      }

      const factory  = new ethers.ContractFactory(abi, bytecode, txSigner);
      const contract = await factory.deploy(k1Address, k2Address, k3Address, opts);
      const txHash   = contract.deploymentTransaction().hash;
      send({ pct: 55, status: 'PENDING', message: 'Tx submitted: ' + txHash });

      const receipt = await contract.deploymentTransaction().wait(1);
      return receipt;
    } catch (e) {
      lastErr = e;
      send({ pct: 36, status: 'RETRY', message: 'Attempt ' + attempt + ' failed: ' + e.message + (attempt < maxAttempts ? ' — retrying...' : '') });
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

router.post('/', async (req, res) => {
  const { deployerKey, k1Address, k2Address, k3Address, chainId, rpcOverride, gasLimitOverride } = req.body;

  if (!deployerKey || !k1Address || !k2Address || !k3Address || !chainId)
    return res.status(400).json({ error: 'Missing required fields' });

  for (const [lbl, a] of [['k1Address',k1Address],['k2Address',k2Address],['k3Address',k3Address]])
    if (!ethers.isAddress(a)) return res.status(400).json({ error: lbl + ' is not a valid address' });

  const addrs = [k1Address, k2Address, k3Address].map(a => a.toLowerCase());
  if (new Set(addrs).size !== 3)
    return res.status(400).json({ error: 'K1, K2, K3 must be distinct addresses' });

  const chain = chains.chains.find(c => c.id === Number(chainId));
  if (!chain) return res.status(400).json({ error: 'Unknown chain ID: ' + chainId });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    send({ step:1, pct:5, status:'COMPILING', message:'Loading / compiling contract artifact...' });
    const { abi, bytecode } = loadArtifact();
    send({ step:1, pct:12, status:'OK', message:'Artifact loaded. Bytecode: ' + ((bytecode.length-2)/2) + ' bytes.' });

    send({ step:1, pct:15, status:'CHECKING', message:'Connecting to ' + chain.name + '...' });
    const rpcUrl   = rpcOverride || chain.rpc;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const deployer = new ethers.Wallet(deployerKey, provider);

    const balance  = await provider.getBalance(deployer.address);
    send({ step:1, pct:18, status:'OK', message:'Deployer: ' + deployer.address + '  balance: ' + ethers.formatEther(balance) + ' ' + chain.symbol });

    if (balance === 0n) {
      send({ step:1, pct:0, status:'ERROR', message:'Deployer balance is zero. Fund the deployer address before proceeding.' });
      return res.end();
    }

    const opts = gasLimitOverride ? { gasLimit: BigInt(gasLimitOverride) } : {};

    send({ step:2, pct:35, status:'DEPLOYING', message:'Initiating deployment sequence...' });
    const receipt = await deployWithRetry(abi, bytecode, deployer, provider, k1Address, k2Address, k3Address, opts, Number(chainId), rpcUrl, send);

    send({ step:3, pct:72, status:'CONFIRMED', message:'Confirmed at block ' + receipt.blockNumber + ' — gas used: ' + receipt.gasUsed.toString(), contractAddress: receipt.contractAddress });

    send({ step:4, pct:85, status:'VERIFYING', message:'Reading on-chain immutables...' });
    const deployed = new ethers.Contract(receipt.contractAddress, abi, provider);
    const [onK1, onK2, onK3, onChainId] = await Promise.all([deployed.K1(), deployed.K2(), deployed.K3(), deployed.GATE_CHAIN_ID()]);

    if (
      onK1.toLowerCase() !== k1Address.toLowerCase() ||
      onK2.toLowerCase() !== k2Address.toLowerCase() ||
      onK3.toLowerCase() !== k3Address.toLowerCase() ||
      Number(onChainId)  !== Number(chainId)
    ) {
      send({ step:4, pct:0, status:'MISMATCH', message:'CRITICAL: on-chain immutables do not match inputs. DO NOT USE this deployment.', onChain:{ K1:onK1, K2:onK2, K3:onK3, chainId:onChainId.toString() } });
      return res.end();
    }

    const result = {
      contractAddress: receipt.contractAddress,
      txHash:          receipt.hash,
      blockNumber:     receipt.blockNumber,
      gasUsed:         receipt.gasUsed.toString(),
      chain:           chain.name,
      chainId:         chain.id,
      explorer:        chain.explorer + '/address/' + receipt.contractAddress,
      K1: onK1, K2: onK2, K3: onK3,
      deployerAddress: deployer.address,
      timestamp:       new Date().toISOString()
    };

    send({ step:5, pct:100, status:'COMPLETE', message:'✅ SecureGate is live. All immutables verified on-chain.', result });
    res.end();
  } catch(e) {
    send({ pct:0, status:'ERROR', message: e.message });
    res.end();
  }
});

module.exports = router;
