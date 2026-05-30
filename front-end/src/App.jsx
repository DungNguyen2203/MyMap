import {
  ReactFlow,
  Background,
  ReactFlowProvider,
  SelectionMode,
  MiniMap,
  useReactFlow,
} from '@xyflow/react';
import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { message } from 'antd'; // THÊM: Để hiển thị thông báo "Đã lưu"
import { useStore } from './store/store';
import CustomNode from './components/CustomNode';
import VerticalToolbar from './components/VerticalToolbar';
import ZoomToolbar from './components/ZoomToolbar';
import CustomEdgeToolbar from './components/CustomEdgeToolbar';
import DarkModeToggle from './components/DarkModeToggle';
import './App.scss';
import DrawAreaNode from './components/DrawAreaNode';
import { markdownToMindmap } from './utils/markdownToMindmap';
import CytoscapeMindmap from './components/CytoscapeMindmap';
import { useCollaboration } from './hooks/useCollaboration';

const nodeTypes = { custom: CustomNode, drawArea: DrawAreaNode };
const FAKE_NODE_ID = 'multi-select-fake-node';

// THÊM: Hàm Debounce để tối ưu auto-save
function debounce(func, wait) {
  let timeout;
  const debounced = (...args) => {
    const context = this;
    const later = () => {
      clearTimeout(timeout);
      func.apply(context, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
  // Thêm hàm .flush() để gọi lưu ngay lập tức (cho nút lưu thủ công)
  debounced.flush = (...args) => {
    clearTimeout(timeout);
    func.apply(this, args);
  };
  return debounced;
}


/* --------------------------- FLOW CONTENT --------------------------- */
// SỬA: Thêm props 'currentMindmapId', 'onManualSave', 'ownerId'
function FlowContent({ currentMindmapId, onManualSave, ownerId }) {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    isMiniMapVisible,
    selectedEdgeId,
    setSelectedEdgeId,
    selectedNodeIds,
    setSelectedNodeIds,
    edgeToolbarPosition,
    copyNodes,
    pasteNodes,
    backgroundVariant,
    patternColor,
    appMode,
    setAppMode,
    addDrawAreaNode,
    currentDrawTool,
    setCurrentDrawTool,
    setActiveDrawArea,
    // THÊM: Lấy state liên quan đến việc tải/lưu
    isLoaded,
    setSaveStatus // (Giả định bạn có hàm này trong store.js)
  } = useStore();

  const reactFlowInstance = useReactFlow();
  const [previewRect, setPreviewRect] = useState(null);
  const isCreating = useRef(false);
  const startPos = useRef(null);
  const previewRectRef = useRef(null);
  const wrapperRef = useRef(null);

  // THÊM: Logic Auto-save và Manual-save
  const { REACT_APP_API_URL } = process.env;
  const isAutoSaving = useRef(false);

  // Hàm gọi API để lưu vào CSDL
  const handleSaveToDB = useCallback(debounce(async (nodesToSave, edgesToSave) => {
    // Chỉ lưu nếu có ID, không đang lưu, và đã tải xong
    if (!currentMindmapId || isAutoSaving.current || !isLoaded) {
      return;
    }

    isAutoSaving.current = true;
    if (setSaveStatus) setSaveStatus('saving');

    try {
      // Xác định URL API dựa trên ownerId (nếu đang cộng tác thì dùng API shared)
      const saveUrl = ownerId
        ? `${REACT_APP_API_URL || ''}/mindmaps/shared/${ownerId}/${currentMindmapId}/save`
        : `${REACT_APP_API_URL || ''}/mindmaps/${currentMindmapId}/save`;
      const response = await fetch(saveUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, 
        body: JSON.stringify({
          nodes: nodesToSave,
          edges: edgesToSave,
        }),
      });

      if (!response.ok) throw new Error('Lỗi khi lưu vào CSDL');
      
      const result = await response.json();
      if(result.success) {
         if (setSaveStatus) setSaveStatus('saved');
      } else {
         throw new Error(result.message || 'Lỗi lưu CSDL');
      }

    } catch (err) {
      console.error("Lỗi auto-save:", err);
      if (setSaveStatus) setSaveStatus('error');
      // Chỉ báo lỗi nếu không phải là lưu thủ công
      if (!onManualSave) {
          message.error("Không thể tự động lưu sơ đồ.");
      }
    } finally {
      isAutoSaving.current = false;
    }
  }, 1500), [currentMindmapId, isLoaded, REACT_APP_API_URL, setSaveStatus, ownerId]); // Delay 1.5s

  // Kích hoạt Auto-save (CHỈ khi thay đổi từ local, KHÔNG khi nhận từ socket)
  useEffect(() => {
    const currentIsRemoteUpdate = useStore.getState().isRemoteUpdate;
    if (isLoaded && nodes.length > 0 && !currentIsRemoteUpdate) {
      handleSaveToDB(nodes, edges);
    }
  }, [nodes, edges, isLoaded, handleSaveToDB]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kết nối với nút Lưu thủ công
  useEffect(() => {
    if (onManualSave) {
      onManualSave.current = () => {
        handleSaveToDB.flush(nodes, edges); // Gọi .flush() để lưu ngay
        message.success('Đã lưu sơ đồ!');
      };
    }
  }, [handleSaveToDB, nodes, edges, onManualSave]);
  

  /* ---- Hiển thị fake node khi multi-select (Giữ nguyên) ---- */
  const nodesToRender = useMemo(() => {
    const selectedNodes = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (selectedNodes.length <= 1 || appMode !== 'normal') return nodes;

    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity;
    selectedNodes.forEach((n) => {
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x);
      minY = Math.min(minY, n.position.y);
    });

    const fakeNode = {
      id: FAKE_NODE_ID,
      type: 'custom',
      position: { x: (minX + maxX) / 2 + 90, y: minY },
      data: selectedNodes[0].data,
      selected: true,
      selectable: false,
      draggable: false,
    };
    return [...nodes, fakeNode];
  }, [nodes, selectedNodeIds, appMode]);

  /* ---- Sự kiện click (Giữ nguyên) ---- */
  const handleEdgeClick = (e, edge) => {
    e.stopPropagation();
    setSelectedEdgeId(edge.id, { x: e.clientX, y: e.clientY });
  };

  const handlePaneClick = (e) => {
    if (appMode === 'normal' && e.target.classList.contains('react-flow__pane')) {
      setSelectedEdgeId(null);
      setSelectedNodeIds([]);
    }
    if (appMode === 'canvasMode' && currentDrawTool.mode !== 'cursor') {
      setCurrentDrawTool({ mode: 'cursor' });
      setActiveDrawArea(null);
    }
  };

  const handleNodeClick = (e, node) => {
    e.stopPropagation();
    setSelectedEdgeId(null);
    if (e.ctrlKey || e.metaKey) {
      setSelectedNodeIds((prev) =>
        prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id]
      );
    } else setSelectedNodeIds([node.id]);
  };

  /* ---- Vẽ khung DrawArea (Giữ nguyên) ---- */
  const handlePaneMouseDown = (e) => {
    if (e.button !== 0 || appMode !== 'creatingDrawArea') return;
    const screenPos = { x: e.clientX, y: e.clientY };
    isCreating.current = true;
    startPos.current = screenPos;
    const initial = { x: screenPos.x, y: screenPos.y, width: 0, height: 0 };
    setPreviewRect(initial);
    previewRectRef.current = initial;
    document.addEventListener('mousemove', handlePaneMouseMove);
    document.addEventListener('mouseup', handlePaneMouseUp);
  };

  const handlePaneMouseMove = (e) => {
    if (!isCreating.current || !startPos.current) return;
    const current = { x: e.clientX, y: e.clientY };
    const rect = {
      x: Math.min(startPos.current.x, current.x),
      y: Math.min(startPos.current.y, current.y),
      width: Math.abs(current.x - startPos.current.x),
      height: Math.abs(current.y - startPos.current.y),
    };
    setPreviewRect(rect);
    previewRectRef.current = rect;
  };

  const handlePaneMouseUp = (e) => {
    document.removeEventListener('mousemove', handlePaneMouseMove);
    document.removeEventListener('mouseup', handlePaneMouseUp);
    if (!isCreating.current) return;
    isCreating.current = false;
    const rect = previewRectRef.current;
    setPreviewRect(null);
    if (rect && rect.width > 10 && rect.height > 10) {
      const topLeft = reactFlowInstance.screenToFlowPosition({ x: rect.x, y: rect.y });
      const bottomRight = reactFlowInstance.screenToFlowPosition({
        x: rect.x + rect.width,
        y: rect.y + rect.height,
      });
      addDrawAreaNode(
        { x: topLeft.x, y: topLeft.y },
        { width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
      );
    }
    setAppMode('normal');
  };

  /* ---- Phím tắt (Giữ nguyên) ---- */
  useEffect(() => {
    const handleKey = (e) => {
      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (isTyping) return;
      if (e.key === 'Escape' && appMode === 'canvasMode') return setAppMode('normal');
      const ctrl = e.ctrlKey || e.metaKey;
      if (appMode === 'normal' && ctrl) {
        if (e.key === 'c' || e.key === 'C') copyNodes();
        if (e.key === 'v' || e.key === 'V') pasteNodes();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [copyNodes, pasteNodes, appMode, setAppMode]);

  return (
    <>
      <div className="reactflow-wrapper" ref={wrapperRef} onMouseDown={handlePaneMouseDown}>
        <ReactFlow
          nodes={nodesToRender}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          onlyRenderVisibleElements
          panOnDrag={[2]}
          selectionOnDrag={true}
          zoomOnScroll
          zoomOnDoubleClick={false}
          nodesDraggable
          nodesConnectable
          selectionMode={SelectionMode.Partial}
          minZoom={0.02}
          maxZoom={3}
          onEdgeClick={handleEdgeClick}
          onPaneClick={handlePaneClick}
          onNodeClick={handleNodeClick}
        >
          <Background variant={backgroundVariant} color={patternColor} />
          {isMiniMapVisible && <MiniMap />}
          {previewRect && (
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 20,
              }}
            >
              <rect
                x={previewRect.x}
                y={previewRect.y}
                width={previewRect.width}
                height={previewRect.height}
                className="preview-rect-svg"
              />
            </svg>
          )}
        </ReactFlow>
      </div>
      <ZoomToolbar />
      {selectedEdgeId && edgeToolbarPosition && (
        <CustomEdgeToolbar
          edgeId={selectedEdgeId}
          style={{ left: edgeToolbarPosition.x, top: edgeToolbarPosition.y }}
        />
      )}
    </>
  );
}

/* --------------------------- COLLABORATOR CURSORS --------------------------- */
const CURSOR_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];

function CollaboratorCursors({ collaborators, currentUserId }) {
  // Lọc ra chỉ collaborators khác (không phải mình) và có cursor position
  const remoteCursors = collaborators.filter(
    (c) => c.id !== currentUserId && c.cursor
  );

  if (remoteCursors.length === 0) return null;

  return (
    <>
      {remoteCursors.map((collab, idx) => (
        <div
          key={collab.id}
          style={{
            position: 'absolute',
            left: collab.cursor.x,
            top: collab.cursor.y,
            pointerEvents: 'none',
            zIndex: 1000,
            transform: 'translate(-2px, -2px)',
            transition: 'left 0.1s ease, top 0.1s ease',
          }}
        >
          {/* Cursor icon */}
          <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
            <path
              d="M0 0L16 12H6L3 20L0 0Z"
              fill={CURSOR_COLORS[idx % CURSOR_COLORS.length]}
              stroke="white"
              strokeWidth="1"
            />
          </svg>
          {/* User name label */}
          <div
            style={{
              position: 'absolute',
              top: '18px',
              left: '10px',
              background: CURSOR_COLORS[idx % CURSOR_COLORS.length],
              color: '#fff',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }}
          >
            {collab.name}
          </div>
        </div>
      ))}
    </>
  );
}

/* --------------------------- COLLAB INDICATOR BAR --------------------------- */
function CollabIndicator({ collaborators, isConnected }) {
  if (!collaborators || collaborators.length <= 1) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(8px)',
        color: '#fff',
        padding: '6px 14px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: 500,
        zIndex: 100,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: isConnected ? '#4ade80' : '#f87171',
          display: 'inline-block',
        }}
      />
      <span>
        {collaborators.length} người đang chỉnh sửa
      </span>
      {/* Avatar stack */}
      <div style={{ display: 'flex', marginLeft: '4px' }}>
        {collaborators.slice(0, 5).map((c, idx) => (
          <div
            key={c.id}
            title={c.name}
            style={{
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              background: CURSOR_COLORS[idx % CURSOR_COLORS.length],
              border: '2px solid rgba(255,255,255,0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 700,
              color: '#fff',
              marginLeft: idx > 0 ? '-6px' : '0',
              zIndex: 5 - idx,
            }}
          >
            {(c.name || '?').charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------- MINDMAP EDITOR --------------------------- */
function MindmapEditor() {
  const darkMode = useStore((s) => s.darkMode);

  // SỬA: Lấy ID và ownerId từ URL, tạo ref cho nút lưu thủ công
  const { id, ownerId } = useParams();
  const manualSaveRef = useRef(null);
  
  // THÊM: Tải mindmap khi component mount (nếu chưa có trong store)
  const { isLoaded, setLoaded, loadState, setCurrentMindmapId, currentMindmapId } = useStore();

  // === THÊM: Kích hoạt Real-time Collaboration ===
  const { collaborators, isConnected, emitCursorMove } = useCollaboration(id);
  
  useEffect(() => {
    // Chỉ tải nếu chưa tải, hoặc ID không khớp
    if (!isLoaded || currentMindmapId !== id) {
      const fetchMindmap = async () => {
         try {
            if(setLoaded) setLoaded(false);
            // Xác định URL API dựa trên ownerId (nếu đang cộng tác thì dùng API shared)
            const fetchUrl = ownerId
              ? `/mindmaps/shared/${ownerId}/${id}/json`
              : `/mindmaps/${id}/json`;
            const res = await fetch(fetchUrl, { credentials: 'include' });
            if (!res.ok) throw new Error('Không thể tải mindmap');
            const data = await res.json();
            if (!data.success || !data.data) throw new Error('Dữ liệu không hợp lệ');

            // Ưu tiên nodes/edges đã lưu, nếu không có thì mới chuyển từ markdown
            if (data.data.nodes && data.data.nodes.length > 0) {
              loadState({ nodes: data.data.nodes, edges: data.data.edges });
            } else {
              const safeMarkdown = typeof data.data.content === 'string' ? data.data.content : '# Mindmap moi';
              const { nodes, edges } = markdownToMindmap(safeMarkdown);
              loadState({ nodes, edges });
            }
            if(setCurrentMindmapId) setCurrentMindmapId(id);
            if(setLoaded) setLoaded(true);
         } catch(err) {
            console.error("Lỗi tải mindmap:", err);
            message.error("Không thể tải sơ đồ. Đang chuyển về dashboard...");
            setTimeout(() => window.location.href = '/dashboard', 2000);
         }
      };
      fetchMindmap();
    }
  }, [id, ownerId, isLoaded, loadState, setLoaded, setCurrentMindmapId, currentMindmapId]);

  // === THÊM: Xử lý mouse move để broadcast cursor ===
  const handleMouseMove = useCallback((e) => {
    // Chỉ emit nếu có người khác đang cùng chỉnh sửa
    if (collaborators && collaborators.length > 1) {
      emitCursorMove({ x: e.clientX, y: e.clientY });
    }
  }, [collaborators, emitCursorMove]);

  return (
    <div
      className={`app-container ${darkMode ? 'dark-mode' : 'light-mode'}`}
      onMouseMove={handleMouseMove}
    >
      <ReactFlowProvider>
        {/* SỬA: Truyền hàm lưu thủ công, mindmapId, currentUserId vào VerticalToolbar */}
        <VerticalToolbar 
          onManualSave={() => manualSaveRef.current && manualSaveRef.current()}
          mindmapId={id}
          currentUserId={useStore((s) => s.socketUserId)}
        />
        <DarkModeToggle />
        {/* === THÊM: Hiển thị thanh chỉ báo collaboration === */}
        <CollabIndicator collaborators={collaborators} isConnected={isConnected} />
        {/* === THÊM: Hiển thị cursor của collaborators === */}
        <CollaboratorCursors collaborators={collaborators} currentUserId={useStore((s) => s.socketUserId)} />
        {/* SỬA: Truyền ID, ownerId và ref xuống FlowContent */}
        <FlowContent 
          currentMindmapId={id} 
          onManualSave={manualSaveRef}
          ownerId={ownerId}
        />
      </ReactFlowProvider>
    </div>
  );
}

/* --------------------------- IMPORT MINDMAP --------------------------- */
function ImportMindmap() {
  const { id } = useParams();
  const navigate = useNavigate();
  // SỬA: Lấy thêm 'setLoaded' và 'setCurrentMindmapId' từ store
  const { loadState, setLoaded, setCurrentMindmapId } = useStore(); 
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // SỬA: Đổi tên hàm và logic bên trong
  const fetchAndLoadMindmap = useCallback(async () => {
    try {
      setLoading(true);
      if (setLoaded) setLoaded(false); // Báo là đang tải
      
      const res = await fetch(`/mindmaps/${id}/json`, { credentials: 'include' });
      if (!res.ok) throw new Error('Không thể tải nội dung mindmap từ server');
      
      const data = await res.json();
      if (!data.success || !data.data) throw new Error('Dữ liệu trả về không hợp lệ');

      let nodes, edges;
      // KIỂM TRA: Ưu tiên dùng nodes/edges nếu đã có trong CSDL
      if (data.data.nodes && data.data.nodes.length > 0) {
        nodes = data.data.nodes;
        edges = data.data.edges || [];
      } else {
        // Nếu không, chuyển đổi từ markdown
        const markdownText = typeof data.data.content === 'string' ? data.data.content : '# Mindmap moi';
        const result = markdownToMindmap(markdownText);
        nodes = result.nodes;
        edges = result.edges;
      }
      
      loadState({ nodes, edges }); // Tải state
      if (setCurrentMindmapId) setCurrentMindmapId(id); // Set ID
      if (setLoaded) setLoaded(true); // Báo đã tải xong

      setLoading(false);
      
      // SỬA: Chuyển hướng đến /editor/:id
      setTimeout(() => navigate(`/editor/${id}`), 300);

    } catch (err) {
      console.error('Error loading mindmap:', err);
      setError(err.message);
      setLoading(false);
    }
  }, [id, loadState, navigate, setLoaded, setCurrentMindmapId]);

  useEffect(() => {
    fetchAndLoadMindmap();
  }, [fetchAndLoadMindmap]);

  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.icon}>🗺️</div>
        {/* SỬA: Đổi text */}
        <h2>Đang tải Mindmap...</h2>
        <p style={{ opacity: 0.8 }}>Vui lòng đợi trong giây lát</p>
        <div style={styles.progressOuter}>
          <div style={styles.progressInner}></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.errorContainer}>
        <div style={{ fontSize: '64px', marginBottom: '20px' }}>❌</div>
        <h2 style={{ color: '#d32f2f', marginBottom: '10px' }}>Lỗi</h2>
        <p style={{ color: '#666', marginBottom: '30px', maxWidth: '500px' }}>{error}</p>
        <div style={{ display: 'flex', gap: '10px' }}>
          {/* SỬA: Bỏ nút "Tạo Mindmap Mới" vì không hợp lý */}
          <button onClick={() => window.location.reload()} style={styles.btnSecondary}>
            Thử Lại
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/* --------------------------- CYTOSCAPE VIEWER (Giữ nguyên) --------------------------- */
function CytoscapeViewer() {
  const { id } = useParams();
  const [markdown, setMarkdown] = useState('');
  useEffect(() => {
    fetch(`/mindmaps/${id}/json`, { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => setMarkdown(data.data?.content || ''))
      .catch(console.error);
  }, [id]);
  if (!markdown) return <div style={{ padding: 40 }}>Đang tải...</div>;
  return <CytoscapeMindmap markdownContent={markdown} />;
}

/* --------------------------- APP MAIN --------------------------- */
function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* SỬA: Route cho editor giờ phải có :id */}
        <Route path="/editor/:id" element={<MindmapEditor />} />
        <Route path="/editor/:id/:ownerId" element={<MindmapEditor />} />
        
        {/* Các route cũ */}
        <Route path="/import/:id" element={<ImportMindmap />} />
        <Route path="/cyto/:id" element={<CytoscapeViewer />} />
        
        {/* THÊM: Route dự phòng, chuyển hướng về dashboard (bên Pug) */}
        <Route path="/" element={<EditorFallback />} />
        <Route path="/editor" element={<EditorFallback />} />
      </Routes>
    </BrowserRouter>
  );
}

// THÊM: Component Fallback để chuyển hướng
function EditorFallback() {
  useEffect(() => {
    // Chuyển hướng về trang dashboard chính (bên Pug)
    window.location.href = '/dashboard';
  }, []);

  return (
    <div style={styles.loadingContainer}>
      <div style={styles.icon}>🧭</div>
      <h2>Đang chuyển hướng...</h2>
      <p style={{ opacity: 0.8 }}>Vui lòng chọn một mindmap từ dashboard.</p>
    </div>
  );
}


/* --------------------------- STYLES (Giữ nguyên) --------------------------- */
const styles = {
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    textAlign: 'center',
  },
  icon: { fontSize: '64px', marginBottom: '20px', animation: 'pulse 1.5s ease-in-out infinite' },
  progressOuter: {
    width: '200px',
    height: '4px',
    background: 'rgba(255,255,255,0.3)',
    borderRadius: '2px',
    overflow: 'hidden',
    marginTop: '20px',
  },
  progressInner: {
    width: '100%',
    height: '100%',
    background: 'white',
    animation: 'loading 1.5s ease-in-out infinite',
  },
  errorContainer: {
    padding: '40px',
    textAlign: 'center',
    background: 'var(--bg-primary)',
    minHeight: '100vh',
  },
  btnPrimary: {
    padding: '12px 24px',
    background: '#4f46e5',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '16px',
  },
  btnSecondary: {
    padding: '12px 24px',
    background: '#666',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '16px',
  },
};

export default App;
