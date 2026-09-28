'use strict';
const express    = require('express');
const { ethers } = require('ethers');
const chains     = require('../config/chains.json');
const router     = express.Router();

router.post('/estimate', async (req, res) => {
  const { chainId, rpcOverride } = req.body;
  const chain = chains.chains.find(c => c.id === Number(chainId));
  if (!chain) return res.status(400).json({ error: 'Unknown chain ID' });
  try {
    const rpcUrl   = rpcOverride || chain.rpc;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const feeData  = await provider.getFeeData();
    const block    = await provider.getBlock('latest');
    const DEPLOY_GAS = 850000n;
    const gasPrice   = feeData.gasPrice || feeData.maxFeePerGas || 0n;
    res.json({
      chainId:             chain.id,
      chainName:           chain.name,
      symbol:              chain.symbol,
      gasPrice:            ethers.formatUnits(gasPrice, 'gwei') + ' gwei',
      gasPriceWei:         gasPrice.toString(),
      estimatedDeployGas:  DEPLOY_GAS.toString(),
      estimatedDeployCost: ethers.formatEther(DEPLOY_GAS * gasPrice) + ' ' + chain.symbol,
      blockNumber:         block.number,
      baseFee:             block.baseFeePerGas ? ethers.formatUnits(block.baseFeePerGas, 'gwei') + ' gwei' : 'N/A'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
