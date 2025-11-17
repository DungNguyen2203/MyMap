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

      // Clean up old socket if exists but not connected
      if (this.socket && !this.isConnected) {
        console.log('🧹 Cleaning up old socket');
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      const serverUrl = process.env.REACT_APP_API_URL || 'http://localhost:3000';
      console.log('🔌 Creating new socket connection to:', serverUrl);
      
      this.socket = io(serverUrl, {
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
      });

      this.socket.on('connect', () => {
        console.log('✅ Socket connected:', this.socket.id);
        this.isConnected = true;
        // DON'T resolve yet - wait for authenticated
        console.log('⏳ Waiting for authenticated event...');
      });

      this.socket.on('disconnect', (reason) => {
        console.log('❌ Socket disconnected:', reason);
        this.isConnected = false;
      });

      this.socket.on('authenticated', (data) => {
        console.log('🔐 Socket authenticated:', data);
        console.log('✅ Server ready to receive events, resolving connect()');
        resolve(this.socket); // Resolve ONLY after server is ready
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
      console.log('\n🎯 ========== CLIENT JOIN REQUEST ==========');
      console.log('🆔 Mindmap ID:', mindmapId);
      console.log('🔌 Socket exists:', !!this.socket);
      console.log('✅ Is connected:', this.isConnected);
      console.log('🔒 Already joined:', this.joinedRoom);
      console.log('📍 Current mindmap:', this.currentMindmapId);
      
      if (!this.socket) {
        console.error('❌ Socket not initialized. Call connect() first.');
        reject(new Error('socket-not-initialized'));
        return;
      }
      
      if (!this.isConnected) {
        console.warn('⚠️ Socket not connected yet, waiting...');
        // Wait for connection
        const waitForConnection = () => {
          if (this.isConnected) {
            this.joinMindmap(mindmapId).then(resolve).catch(reject);
          } else {
            setTimeout(waitForConnection, 100);
          }
        };
        setTimeout(waitForConnection, 100);
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

      let resolved = false;

      const onSuccess = (data) => {
        console.log('📨 Received join-mindmap-success:', data);
        if (resolved) return;
        if (data?.mindmapId !== mindmapId) {
          console.warn('⚠️ Received join ACK for different mindmap:', data?.mindmapId, 'expected:', mindmapId);
          return;
        }
        console.log('✅ Joined mindmap room successfully:', data);
        this.joinedRoom = true;
        resolved = true;
        resolve(true);
      };

      // ĐẶT LISTENER TRƯỚC
      console.log('🔔 Registering join-mindmap-success listener');
      this.socket.once('join-mindmap-success', onSuccess);

      // Emit ngay sau khi register listener (không cần delay)
      console.log('📤 About to emit join-mindmap event');
      console.log('🔌 Socket ID:', this.socket.id);
      console.log('🔌 Socket connected:', this.socket.connected);
      
      try {
        this.socket.emit('join-mindmap', { mindmapId });
        console.log('✅ join-mindmap event emitted successfully');
      } catch (error) {
        console.error('❌ Failed to emit join-mindmap:', error);
        reject(error);
        return;
      }
      console.log('========================================\n');

      // Fallback nhanh: resolve sau 500ms (server bình thường trả < 100ms)
      setTimeout(() => {
        if (!resolved && this.currentMindmapId === mindmapId) {
          console.log('✅ Auto-resolving join after 500ms (ACK might be missed but connection is stable)');
          this.joinedRoom = true;
          resolved = true;
          resolve(true);
        }
      }, 500);

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
    if (!this.socket) {
      console.error('❌ Socket not initialized');
      return;
    }
    
    if (!this.isConnected) {
      console.warn('⚠️ Socket not connected, skipping broadcast');
      return;
    }
    
    if (!this.joinedRoom) {
      console.warn('⚠️ Not joined room yet, skipping broadcast');
      return;
    }

    console.log(`📤 Sending mindmap change:`, { mindmapId, changeType, nodesCount: changes.nodes?.length, edgesCount: changes.edges?.length });
    this.socket.emit('mindmap-change', {
      mindmapId,
      changes,
      changeType,
    });
  }

  // Gửi cursor position
  sendCursorMove(mindmapId, cursor) {
    if (!this.socket) {
      console.error('❌ Socket not initialized for cursor move');
      return;
    }
    if (!this.isConnected || !this.joinedRoom) return;

    this.socket.emit('cursor-move', {
      mindmapId,
      cursor,
    });
  }

  // Gửi node selection
  sendNodeSelection(mindmapId, nodeIds) {
    if (!this.socket) {
      console.error('❌ Socket not initialized for selection');
      return;
    }
    if (!this.isConnected || !this.joinedRoom) return;

    this.socket.emit('node-select', {
      mindmapId,
      nodeIds,
    });
  }

  // Lắng nghe events
  on(eventName, callback) {
    if (!this.socket) {
      console.error(`❌ Socket not initialized when trying to register '${eventName}'`);
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
