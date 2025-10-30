const { ethers } = require('ethers');

function getEvmConfig() {
  const cfg = {
    rpcUrl: process.env.EVM_RPC_URL || '',
    chainId: Number(process.env.EVM_CHAIN_ID || 0),
    tokenAddress: (process.env.EVM_TOKEN_ADDRESS || '').toLowerCase(),
    tokenDecimals: Number(process.env.EVM_TOKEN_DECIMALS || 6),
    merchant: (process.env.MERCHANT_WALLET_ADDRESS || '').toLowerCase(),
  };
  cfg.enabled = !!(cfg.rpcUrl && cfg.chainId && cfg.tokenAddress && cfg.tokenDecimals >= 0 && cfg.merchant);
  return cfg;
}

function getProvider() {
  const { rpcUrl } = getEvmConfig();
  if (!rpcUrl) throw new Error('EVM_RPC_URL missing');
  return new ethers.JsonRpcProvider(rpcUrl);
}

function amountUnitsFromCents(cents, decimals) {
  // amount = cents/100 * 10^decimals
  const d = BigInt(decimals);
  const pow = 10n ** d;
  return (BigInt(cents) * pow) / 100n;
}

const ERC20_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

async function verifyErc20Payment({ order, txHash }) {
  const cfg = getEvmConfig();
  if (!cfg.enabled) throw new Error('EVM not configured');
  const provider = getProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return { ok: false, reason: 'tx not confirmed' };
  // Optional: ensure tx.to is token address when calling transfer
  // But some wallets may use routers; rely on logs instead.
  const expected = amountUnitsFromCents(order.price_cents, cfg.tokenDecimals);
  const tokenAddr = cfg.tokenAddress;
  let matched = false;
  for (const log of receipt.logs || []) {
    if ((log.address || '').toLowerCase() !== tokenAddr) continue;
    try {
      const parsed = ERC20_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed?.name === 'Transfer') {
        const from = (parsed.args[0] || '').toLowerCase();
        const to = (parsed.args[1] || '').toLowerCase();
        const value = BigInt(parsed.args[2].toString());
        if (to === cfg.merchant && value === expected) {
          matched = true;
          break;
        }
      }
    } catch (_) {}
  }
  if (!matched) return { ok: false, reason: 'no matching transfer' };

  // Optional: ensure block time is after order creation
  try {
    const block = await provider.getBlock(receipt.blockNumber);
    const created = new Date(order.created_at).getTime();
    if (block && created && block.timestamp * 1000 < created - 5 * 60 * 1000) {
      return { ok: false, reason: 'tx older than order' };
    }
  } catch (_) {}
  return { ok: true };
}

module.exports = { getEvmConfig, getProvider, verifyErc20Payment, amountUnitsFromCents };

