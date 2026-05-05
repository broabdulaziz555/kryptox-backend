// Fetches prices from CoinGecko every 60 seconds, with exponential backoff on rate-limit
const COINS = [
  { symbol: 'BTC',   id: 'bitcoin' },
  { symbol: 'ETH',   id: 'ethereum' },
  { symbol: 'USDT',  id: 'tether' },
  { symbol: 'USDC',  id: 'usd-coin' },
  { symbol: 'BNB',   id: 'binancecoin' },
  { symbol: 'SOL',   id: 'solana' },
  { symbol: 'TRX',   id: 'tron' },
  { symbol: 'TON',   id: 'the-open-network' },
  { symbol: 'XRP',   id: 'ripple' },
  { symbol: 'ADA',   id: 'cardano' },
  { symbol: 'DOGE',  id: 'dogecoin' },
  { symbol: 'AVAX',  id: 'avalanche-2' },
  { symbol: 'MATIC', id: 'matic-network' },
  { symbol: 'DOT',   id: 'polkadot' },
  { symbol: 'LTC',   id: 'litecoin' },
  { symbol: 'LINK',  id: 'chainlink' },
  { symbol: 'UNI',   id: 'uniswap' },
  { symbol: 'ATOM',  id: 'cosmos' },
  { symbol: 'DAI',   id: 'dai' },
];

module.exports = (prisma) => {
  let backoffMs = 60_000;          // start at 1 min, double on 429, reset on success
  const MAX_BACKOFF_MS = 900_000;  // cap at 15 min

  const updatePrices = async () => {
    try {
      const ids = COINS.map(c => c.id).join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000), // 10s timeout
      });

      if (res.status === 429) {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        console.log(`⚠️  CoinGecko rate-limited — backing off to ${backoffMs / 1000}s`);
        setTimeout(updatePrices, backoffMs);
        return;
      }

      if (!res.ok) {
        console.log(`⚠️  CoinGecko error ${res.status} — retrying in ${backoffMs / 1000}s`);
        setTimeout(updatePrices, backoffMs);
        return;
      }

      const data = await res.json();
      backoffMs = 60_000; // reset on success

      for (const coin of COINS) {
        const info = data[coin.id];
        if (!info) continue;
        await prisma.priceCache.upsert({
          where:  { symbol: coin.symbol },
          create: { symbol: coin.symbol, priceUSD: info.usd, change24h: info.usd_24h_change || 0 },
          update: { priceUSD: info.usd,   change24h: info.usd_24h_change || 0 },
        });
      }
      console.log('✅ Prices updated');
    } catch (err) {
      console.log('⚠️  Price update failed:', err.message);
    }

    // Schedule next run (normal interval when not in backoff)
    setTimeout(updatePrices, backoffMs);
  };

  // First run after 5s to let DB settle, then self-schedules
  setTimeout(updatePrices, 5_000);
};
