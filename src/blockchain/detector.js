const { ethers } = require('ethers');

module.exports = async (io, prisma) => {
  if (!process.env.ALCHEMY_WEBSOCKET_URL) {
    console.log('⚠️  No Alchemy WebSocket URL — blockchain detector disabled');
    return;
  }

  try {
    const provider = new ethers.WebSocketProvider(process.env.ALCHEMY_WEBSOCKET_URL);
    console.log('🔗 Blockchain detector connected to Sepolia');

    provider.on('block', async (blockNumber) => {
      try {
        const block = await provider.getBlock(blockNumber, true);
        if (!block?.prefetchedTransactions) return;

        // Get all user addresses
        const users = await prisma.user.findMany({
          select: { username: true, publicAddress: true }
        });
        const addressMap = Object.fromEntries(
          users.map(u => [u.publicAddress.toLowerCase(), u.username])
        );

        for (const tx of block.prefetchedTransactions) {
          if (!tx.to) continue;
          const toAddr = tx.to.toLowerCase();
          const receiverUsername = addressMap[toAddr];

          if (!receiverUsername) continue;

          const amountETH = parseFloat(ethers.formatEther(tx.value));
          if (amountETH <= 0) continue;

          // Identify sender
          const fromAddr = tx.from.toLowerCase();
          const senderUsername = addressMap[fromAddr] || null;

          // Create receipt message
          const message = await prisma.message.create({
            data: {
              fromUsername: senderUsername || tx.from,
              toUsername: receiverUsername,
              text: `Received ${amountETH.toFixed(6)} ETH on Sepolia`,
              amount: amountETH,
              currency: 'ETH',
              txHash: tx.hash,
              type: 'RECEIPT',
              status: 'CONFIRMED'
            }
          });

          // Emit to receiver
          io.to(receiverUsername).emit('new_message', message);
          io.to(receiverUsername).emit('payment_confirmed', {
            message,
            amount: amountETH,
            currency: 'ETH',
            from: senderUsername || tx.from,
            txHash: tx.hash
          });

          // Check pending invoices
          const pendingInvoices = await prisma.invoice.findMany({
            where: { businessUsername: receiverUsername, status: 'PENDING' }
          });
          for (const inv of pendingInvoices) {
            if (inv.currency === 'ETH' && Math.abs(inv.amount - amountETH) < 0.0001) {
              await prisma.invoice.update({
                where: { id: inv.id },
                data: { status: 'PAID', paidAt: new Date(), txHash: tx.hash, paidByUsername: senderUsername || tx.from }
              });
              io.to(receiverUsername).emit('invoice_paid', inv);
            }
          }

          console.log(`💰 Payment detected: ${amountETH} ETH → @${receiverUsername}`);
        }
      } catch (err) {
        console.error('Block processing error:', err.message);
      }
    });

    provider.on('error', (err) => {
      console.error('WebSocket provider error:', err.message);
    });
  } catch (err) {
    console.error('Blockchain detector failed to start:', err.message);
  }
};
