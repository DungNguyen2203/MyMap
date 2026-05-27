// File: front-end/src/services/socket.js
// Socket.IO Client Singleton cho Real-time Collaboration
import { io } from 'socket.io-client';

let socket = null;

/**
 * Lấy hoặc tạo kết nối Socket.IO singleton.
 * Kết nối tới cùng origin (backend chạy chung cổng với frontend).
 */
export const getSocket = () => {
  if (!socket) {
    // Kết nối tới backend server (cùng origin khi đã build, hoặc proxy khi dev)
    const serverUrl = process.env.REACT_APP_API_URL || '';
    socket = io(serverUrl, {
      withCredentials: true,
      autoConnect: false, // Không tự kết nối ngay, để component quyết định
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
};

/**
 * Ngắt kết nối socket và reset singleton.
 */
export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export default getSocket;
