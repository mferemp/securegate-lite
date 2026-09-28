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
    throw new Error('Artifact has no bytecode. Run COMPILE CONTRACT first.');
  return art;
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
    send({ step:1, pct:5,  status:'COMPILING', message:'Loading contract artifact...' });
    const { abi, bytecode } = loadArtifact();

    send({ step:1, pct:10, status:'CHECKING',  message:'Connecting to ' + chain.name + '...' });
    const provider = new ethers.JsonRpcProvider(rpcOverride || chain.rpc);
    const deployer = new ethers.Wallet(deployerKey, provider);

    const balance = await provider.getBalance(deployer.address);
    send({ step:1, pct:15, status:'OK', message:'Deployer ' + deployer.address + ' — balance: ' + ethers.formatEther(balance) + ' ' + chain.symbol });

    if (balance === 0n) {
      send({ step:1, pct:0, status:'ERROR', message:'Deployer balance is zero. Fund it before deploying.' });
      return res.end();
    }

    send({ step:2, pct:30, status:'DEPLOYING', message:'Broadcasting deployment on ' + chain.name + '...' });
    const factory = new ethers.ContractFactory(abi, bytecode, deployer);
    const opts    = gasLimitOverride ? { gasLimit: BigInt(gasLimitOverride) } : {};
    const contract = await factory.deploy(k1Address, k2Address, k3Address, opts);
    const txHash   = contract.deploymentTransaction().hash;
    send({ step:2, pct:50, status:'PENDING', message:'Tx submitted: ' + txHash });

    const receipt = await contract.deploymentTransaction().wait(1);
    send({ step:3, pct:70, status:'CONFIRMED', message:'Confirmed block ' + receipt.blockNumber + ' — gas used: ' + receipt.gasUsed.toString(), contractAddress: receipt.contractAddress });

    send({ step:4, pct:85, status:'VERIFYING', message:'Reading on-chain immutables...' });
    const deployed = new ethers.Contract(receipt.contractAddress, abi, provider);
    const [onK1, onK2, onK3, onChainId] = await Promise.all([deployed.K1(), deployed.K2(), deployed.K3(), deployed.GATE_CHAIN_ID()]);

    const ok1 = onK1.toLowerCase() === k1Address.toLowerCase();
    const ok2 = onK2.toLowerCase() === k2Address.toLowerCase();
    const ok3 = onK3.toLowerCase() === k3Address.toLowerCase();
    const okC = Number(onChainId)   === Number(chainId);

    if (!ok1 || !ok2 || !ok3 || !okC) {
      send({ step:4, pct:0, status:'MISMATCH', message:'CRITICAL: on-chain keys or chain ID do not match inputs.', onChain:{ K1:onK1, K2:onK2, K3:onK3, chainId:onChainId.toString() } });
      return res.end();
    }

    const result = {
      contractAddress: receipt.contractAddress,
      txHash, blockNumber: receipt.blockNumber,
      gasUsed:         receipt.gasUsed.toString(),
      chain:           chain.name,
      chainId:         chain.id,
      explorer:        chain.explorer + '/address/' + receipt.contractAddress,
      K1: onK1, K2: onK2, K3: onK3,
      deployerAddress: deployer.address,
      timestamp:       new Date().toISOString()
    };

    send({ step:5, pct:100, status:'COMPLETE', message:'\u2705 SecureGate is live. All immutables verified.', result });
    res.end();
  } catch(e) {
    send({ pct:0, status:'ERROR', message: e.message });
    res.end();
  }
});

module.exports = router;
