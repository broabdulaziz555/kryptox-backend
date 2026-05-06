module.exports = (io, prisma) => {
  const onlineUsers = new Map(); // username -> socketId

  io.on('connection', (socket) => {

    socket.on('join_room', (username) => {
      if (!username || typeof username !== 'string') return;
      socket.join(username);
      onlineUsers.set(username, socket.id);
      io.emit('user_online', { username, online: true });
    });

    socket.on('typing', ({ toUsername, fromUsername }) => {
      if (toUsername && fromUsername) {
        socket.to(toUsername).emit('typing', { username: fromUsername });
      }
    });

    socket.on('stop_typing', ({ toUsername, fromUsername }) => {
      if (toUsername && fromUsername) {
        socket.to(toUsername).emit('stop_typing', { username: fromUsername });
      }
    });

    socket.on('message_read', async ({ messageId, fromUsername }) => {
      try {
        await prisma.message.update({
          where: { id: messageId },
          data:  { status: 'CONFIRMED' },
        });
        socket.to(fromUsername).emit('message_read', { messageId });
      } catch { /* message may already be read */ }
    });

    // Heartbeat — client sends ping, we respond pong
    socket.on('ping_kx', () => socket.emit('pong_kx'));

    socket.on('disconnect', () => {
      for (const [username, sid] of onlineUsers.entries()) {
        if (sid === socket.id) {
          onlineUsers.delete(username);
          io.emit('user_online', { username, online: false });
          break;
        }
      }
    });
  });

  // Expose online user lookup for routes
  io.getOnlineUsers = () => [...onlineUsers.keys()];
};
