// File: front-end/src/hooks/useCollaboration.js
// Custom hook cho tính năng cộng tác chỉnh sửa mindmap real-time
import { useEffect, useRef, useCallback } from 'react';
import { getSocket } from '../services/socket';
import { useStore } from '../store/store';

/**
 * Hook quản lý real-time collaboration cho mindmap editor.
 * 
 * @param {string} mindmapId - ID của mindmap đang chỉnh sửa
 * @returns {{ collaborators: Array, isConnected: boolean, emitCursorMove: Function }}
 */
export const useCollaboration = (mindmapId) => {
  const socket = getSocket();
  const isConnectedRef = useRef(false);
  const lastEmittedNodesRef = useRef(null);
  const lastEmittedEdgesRef = useRef(null);
  const isRemoteUpdateRef = useRef(false); // Flag để tránh vòng lặp broadcast
  const cursorThrottleRef = useRef(null); // Throttle cho cursor movement

  // Lấy các hàm và state từ store
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const isLoaded = useStore((s) => s.isLoaded);
  const setCollaborators = useStore((s) => s.setCollaborators);
  const applyRemoteNodesChange = useStore((s) => s.applyRemoteNodesChange);
  const applyRemoteEdgesChange = useStore((s) => s.applyRemoteEdgesChange);
  const setCollabConnected = useStore((s) => s.setCollabConnected);
  const updateCollaboratorCursor = useStore((s) => s.updateCollaboratorCursor);
  const setSocketUserId = useStore((s) => s.setSocketUserId);

  // === 1. KẾT NỐI VÀ JOIN ROOM ===
  useEffect(() => {
    if (!mindmapId || !isLoaded) return;

    // Kết nối socket nếu chưa connected
    if (!socket.connected) {
      socket.connect();
    }

    const handleConnect = () => {
      console.log('🔌 [Collab] Socket connected:', socket.id);
      isConnectedRef.current = true;
      setCollabConnected(true);

      // Join vào room của mindmap
      socket.emit('joinMindmap', { mindmapId });
    };

    // Lắng nghe authenticated event để lưu userId
    const handleAuthenticated = (data) => {
      console.log('👤 [Collab] Authenticated as:', data.userId);
      setSocketUserId(data.userId);
    };

    const handleDisconnect = (reason) => {
      console.log('🔌 [Collab] Socket disconnected:', reason);
      isConnectedRef.current = false;
      setCollabConnected(false);
      setCollaborators([]);
    };

    // === 2. LẮNG NGHE SỰ KIỆN TỪ SERVER ===

    // Nhận danh sách collaborators hiện tại trong room
    const handleCollaborators = (data) => {
      console.log('👥 [Collab] Collaborators updated:', data.users);
      setCollaborators(data.users || []);
    };

    // Nhận thay đổi nodes từ collaborator khác
    const handleRemoteNodesChange = (data) => {
      console.log('📥 [Collab] Remote nodes change received from:', data.userId);
      isRemoteUpdateRef.current = true;
      applyRemoteNodesChange(data.nodes);
      // Reset flag sau một tick để cho phép local changes emit lại bình thường
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    };

    // Nhận thay đổi edges từ collaborator khác
    const handleRemoteEdgesChange = (data) => {
      console.log('📥 [Collab] Remote edges change received from:', data.userId);
      isRemoteUpdateRef.current = true;
      applyRemoteEdgesChange(data.edges);
      setTimeout(() => { isRemoteUpdateRef.current = false; }, 100);
    };

    // Nhận vị trí con trỏ của collaborator khác
    const handleRemoteCursor = (data) => {
      // Cập nhật cursor position vào collaborators state
      updateCollaboratorCursor(data.userId, data.cursor);
    };

    // Đăng ký event listeners
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('authenticated', handleAuthenticated);
    socket.on('mindmapCollaborators', handleCollaborators);
    socket.on('mindmapNodesChanged', handleRemoteNodesChange);
    socket.on('mindmapEdgesChanged', handleRemoteEdgesChange);
    socket.on('mindmapCursorMoved', handleRemoteCursor);

    // Nếu socket đã connected (reconnection), join room ngay
    if (socket.connected) {
      handleConnect();
    }

    // === CLEANUP ===
    return () => {
      console.log('🔌 [Collab] Leaving mindmap room:', mindmapId);
      socket.emit('leaveMindmap', { mindmapId });
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('authenticated', handleAuthenticated);
      socket.off('mindmapCollaborators', handleCollaborators);
      socket.off('mindmapNodesChanged', handleRemoteNodesChange);
      socket.off('mindmapEdgesChanged', handleRemoteEdgesChange);
      socket.off('mindmapCursorMoved', handleRemoteCursor);
      setCollaborators([]);
      setCollabConnected(false);
      // Clear throttle timer
      if (cursorThrottleRef.current) clearTimeout(cursorThrottleRef.current);
    };
  }, [mindmapId, isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // === 3. BROADCAST THAY ĐỔI LOCAL NODES ===
  useEffect(() => {
    // Không emit nếu: chưa load xong, chưa connect, hoặc đang nhận remote update
    if (!isLoaded || !isConnectedRef.current || isRemoteUpdateRef.current) return;
    if (!mindmapId) return;

    // So sánh nông để tránh emit khi không thực sự thay đổi
    const nodesJson = JSON.stringify(nodes);
    if (lastEmittedNodesRef.current === nodesJson) return;
    lastEmittedNodesRef.current = nodesJson;

    socket.emit('mindmapNodesChange', {
      mindmapId,
      nodes,
    });
  }, [nodes, isLoaded, mindmapId]); // eslint-disable-line react-hooks/exhaustive-deps

  // === 4. BROADCAST THAY ĐỔI LOCAL EDGES ===
  useEffect(() => {
    if (!isLoaded || !isConnectedRef.current || isRemoteUpdateRef.current) return;
    if (!mindmapId) return;

    const edgesJson = JSON.stringify(edges);
    if (lastEmittedEdgesRef.current === edgesJson) return;
    lastEmittedEdgesRef.current = edgesJson;

    socket.emit('mindmapEdgesChange', {
      mindmapId,
      edges,
    });
  }, [edges, isLoaded, mindmapId]); // eslint-disable-line react-hooks/exhaustive-deps

  // === 5. BROADCAST VỊ TRÍ CON TRỎ (throttled ~50ms) ===
  const emitCursorMove = useCallback((cursor) => {
    if (!isConnectedRef.current || !mindmapId) return;
    // Throttle: chỉ gửi tối đa 20 lần/giây
    if (cursorThrottleRef.current) return;
    cursorThrottleRef.current = setTimeout(() => {
      cursorThrottleRef.current = null;
    }, 50);

    socket.emit('mindmapCursorMove', {
      mindmapId,
      cursor, // { x, y }
    });
  }, [mindmapId, socket]);

  return {
    collaborators: useStore((s) => s.collaborators),
    isConnected: useStore((s) => s.collabConnected),
    emitCursorMove,
  };
};

export default useCollaboration;
