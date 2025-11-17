// File: services/socketService.js
import io from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.joinedRoom = false; // Track join room status
    this.currentMindmapId = null;
    this.listeners = new Map();
  }

  // Kết nối Socket.IO - Return Promise
  connect() {
    return new Promise((resolve, reject) => {
      if (this.socket && this.isConnected) {
        console.log('⚠️ Socket already connected');
        resolve(this.socket);
        return;
      }

      const serverUrl = process.env.REACT_APP_API_URL || 'http://localhost:3000';
      
      this.socket = io(serverUrl, {
        withCredentials: true, // Để gửi cookies/session
        transports: ['websocket', 'polling'],
      });

      this.socket.on('connect', () => {
        console.log('✅ Socket connected:', this.socket.id);
        this.isConnected = true;
        resolve(this.socket);
      });

      this.socket.on('disconnect', (reason) => {
        console.log('❌ Socket disconnected:', reason);
        this.isConnected = false;
      });

      this.socket.on('authenticated', (data) => {
        console.log('🔐 Socket authenticated:', data);
      });

      this.socket.on('mindmap-error', (message) => {
        console.error('🚨 Mindmap error:', message);
      });

      this.socket.on('connect_error', (error) => {
        console.error('❌ Socket connection error:', error);
        reject(error);
      });

      // Timeout sau 5s
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Socket connection timeout'));
        }
      }, 5000);
    });
  }

  // Ngắt kết nối
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.currentMindmapId = null;
      this.listeners.clear();
    }
  }

  // Join một mindmap room (trả về Promise khi đã sẵn sàng)
  joinMindmap(mindmapId) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        console.error('❌ Socket not connected. Call connect() first.');
        reject(new Error('socket-not-connected'));
        return;
      }

      if (this.currentMindmapId === mindmapId && this.joinedRoom) {
        console.log('⚠️ Already in this mindmap room (ready)');
        resolve(true);
        return;
      }

      // Leave room cũ nếu có
      if (this.currentMindmapId && this.currentMindmapId !== mindmapId) {
        this.leaveMindmap(this.currentMindmapId);
      }

      console.log(`🎨 Joining mindmap room: ${mindmapId}`);

      // Reset trạng thái trước khi join
      this.joinedRoom = false;
      this.currentMindmapId = mindmapId;

      const onSuccess = (data) => {
        if (data?.mindmapId !== mindmapId) return; // ignore other joins
        console.log('✅ Joined mindmap room successfully:', data);
        this.joinedRoom = true;
        this.socket?.off('join-mindmap-success', onSuccess);
        resolve(true);
      };

      // Lắng nghe xác nhận từ server (một lần)
      this.socket.once('join-mindmap-success', onSuccess);

      // Gửi yêu cầu join
      this.socket.emit('join-mindmap', { mindmapId });

      // Fallback: resolve sau 1200ms nếu không nhận được response (đôi khi server trả ACK chậm)
      setTimeout(() => {
        if (!this.joinedRoom && this.currentMindmapId === mindmapId) {
          console.warn('⚠️ Join confirmation timeout, assuming success');
          this.joinedRoom = true;
          resolve(true);
        }
      }, 1200);

      // Safety timeout 5s
      setTimeout(() => {
        if (!this.joinedRoom && this.currentMindmapId === mindmapId) {
          reject(new Error('join-room-timeout'));
        }
      }, 5000);
    });
  }

  // Leave mindmap room
  leaveMindmap(mindmapId) {
    if (!this.socket) return;

    console.log(`🚪 Leaving mindmap room: ${mindmapId}`);
    this.socket.emit('leave-mindmap', { mindmapId });
    this.joinedRoom = false; // Mark as not joined
    
    if (this.currentMindmapId === mindmapId) {
      this.currentMindmapId = null;
    }
  }

  // Gửi thay đổi mindmap (nodes/edges)
  sendMindmapChange(mindmapId, changes, changeType) {
    if (!this.socket || !this.isConnected || !this.joinedRoom) {
      console.warn('⚠️ Cannot send changes: socket not ready or not joined room');
      return;
    }

    console.log(`📤 Sending mindmap change:`, { mindmapId, changeType, nodesCount: changes.nodes?.length, edgesCount: changes.edges?.length });
    this.socket.emit('mindmap-change', {
      mindmapId,
      changes,
      changeType, // 'nodes' | 'edges' | 'both'
    });
  }

  // Gửi cursor position
  sendCursorMove(mindmapId, cursor) {
    if (!this.socket || !this.isConnected) return;

    this.socket.emit('cursor-move', {
      mindmapId,
      cursor, // { x, y }
    });
  }

  // Gửi node selection
  sendNodeSelection(mindmapId, nodeIds) {
    if (!this.socket || !this.isConnected) return;

    this.socket.emit('node-select', {
      mindmapId,
      nodeIds,
    });
  }

  // Lắng nghe events
  on(eventName, callback) {
    if (!this.socket) {
      console.error('❌ Socket not initialized');
      return;
    }

    // Lưu listener để có thể off sau này
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName).push(callback);

    this.socket.on(eventName, callback);
  }

  // Bỏ lắng nghe event
  off(eventName, callback) {
    if (!this.socket) return;

    this.socket.off(eventName, callback);

    // Xóa khỏi tracking
    if (this.listeners.has(eventName)) {
      const callbacks = this.listeners.get(eventName);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // Bỏ tất cả listeners của một event
  offAll(eventName) {
    if (!this.socket) return;

    const callbacks = this.listeners.get(eventName) || [];
    callbacks.forEach(callback => {
      this.socket.off(eventName, callback);
    });
    this.listeners.delete(eventName);
  }
}

// Singleton instance
const socketService = new SocketService();
export default socketService;
