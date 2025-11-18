import React, { memo, useState, useEffect, useRef, useCallback } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import { useStore } from '../store/store';
import CustomNodeToolbar from './CustomNodeToolbar';

// ID cho node giả (PHẢI GIỐNG VỚI App.jsx)
const FAKE_NODE_ID = 'multi-select-fake-node';

// --- (Các hàm helper) ---
const hexToRgba = (hex = '#000000', opacity = 1) => {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(char => char + char).join('');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};
const isImageUrl = (text) => {
  return text && (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('data:image'));
};
// --- Hết Helper ---


function CustomNode({ id, data, selected, sourcePosition, targetPosition }) {
  // --- (Lấy state và actions từ store) ---
  const selectedNodeIds = useStore(s => s.selectedNodeIds);
  const { updateNodeData, updateNodeSize, addMindMapNode, setNodeDraggable, setEditingNodeId } = useStore();

  // --- (State local của component) ---
  const [isEditing, setIsEditing] = useState(false);
  const [isTexting, setIsTexting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  // ✅ CHỈ dùng local state KHI đang edit, còn lại render từ props
  const [editingLabel, setEditingLabel] = useState('');
  const textareaRef = useRef(null);
  const textSizerRef = useRef(null);

  // ✅ Label hiển thị: nếu đang edit thì dùng editingLabel, không thì dùng data.label
  const displayLabel = isTexting ? editingLabel : data.label;

  // 🔥 Debounce timer for real-time broadcast
  const broadcastTimerRef = useRef(null);

  // --- (Các hàm xử lý sự kiện: resize, double-click, blur, keydown) ---
  const handleResize = (event, params) => {
    updateNodeSize(id, { width: params.width });
  };

  // 🔥 onChange: Broadcast text changes while typing (debounced 100ms)
  const handleTextChange = useCallback((e) => {
    const newText = e.target.value;
    setEditingLabel(newText);

    // Clear previous timer
    if (broadcastTimerRef.current) {
      clearTimeout(broadcastTimerRef.current);
    }

    // Debounce: Broadcast after 100ms of no typing
    broadcastTimerRef.current = setTimeout(() => {
      console.log(`⌨️ Broadcasting text change for node ${id}:`, newText);
      updateNodeData(id, { label: newText });
    }, 100);
  }, [id, updateNodeData]);
  const handleDoubleClick = (e) => {
    e.stopPropagation();
    setEditingLabel(data.label); // ✅ Copy data.label vào editing state
    setIsEditing(true);
    setIsTexting(true);
    setEditingNodeId(id); // 🔒 Lock node khỏi remote updates
  };
  const handleBlur = () => {
    // Clear debounce timer
    if (broadcastTimerRef.current) {
      clearTimeout(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }

    // ✅ So sánh với data.label (props) chứ không phải local state
    if (data.label !== editingLabel) {
      console.log(`💾 Final save on blur for node ${id}:`, editingLabel);
      updateNodeData(id, { label: editingLabel });
    }
    setIsEditing(false);
    setIsTexting(false);
    setEditingNodeId(null); // 🔓 Unlock - cho phép remote updates
  };
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleBlur();
    }
  };

  // --- (Các hook useEffect: focus, draggable) ---
  useEffect(() => {
    if (isTexting) {
      textareaRef.current?.focus();
      const t = textareaRef.current;
      if (t) {
        t.setSelectionRange(t.value.length, t.value.length);
        t.scrollTop = t.scrollHeight;
      }
    }
  }, [isTexting]);

  // ✅ KHÔNG CẦN sync label nữa vì render trực tiếp từ data.label!
  // Remote updates sẽ tự động hiển thị qua displayLabel

  useEffect(() => {
    setNodeDraggable(id, !isEditing);
  }, [isEditing, id, setNodeDraggable]);

  // --- (Hàm thêm node con) ---
  const handleAddNode = (e, direction) => {
    e.stopPropagation();
    const sourceNode = useStore.getState().nodes.find(n => n.id === id);
    if (sourceNode) addMindMapNode(sourceNode, direction);
  };

  // --- (useEffect tự động Sizing) ---
  useEffect(() => {
    // Logic này giữ nguyên, nó tự động tính toán chiều cao
    const textarea = textareaRef.current;
    const textSizer = textSizerRef.current;
    if (!textarea || !textSizer) return;
    const s = data.style || {};
    const curWidth = typeof s.width === 'number' ? s.width : parseInt(String(s.width || 0), 10);
    const curHeight = typeof s.height === 'number' ? s.height : parseInt(String(s.height || 0), 10);
    const borderStr = s.border || '0px';
    const borderWidth = parseInt(borderStr.split(' ')[0], 10) || 0;
    const horizontalPadding = 20 * 2;
    const verticalPadding = 10 * 2;
    const totalBorder = borderWidth * 2;
    textSizer.style.fontSize = typeof s.fontSize === 'number' ? `${s.fontSize}px` : s.fontSize || '14px';
    textSizer.style.fontFamily = s.fontFamily || 'Arial';
    textSizer.style.fontWeight = s.fontWeight || 'normal';
    textSizer.style.fontStyle = s.fontStyle || 'normal';
    const currentText = displayLabel || ' ';
    textSizer.textContent = currentText + '\u200B';
    const newSize = {};
    let sizeChanged = false;
    let textSizerWidth;
    if (isTexting) {
      textSizer.style.width = 'auto';
      const newWidth = textSizer.scrollWidth + horizontalPadding + totalBorder;
      const effectiveWidth = Math.max(curWidth, newWidth);
      textSizerWidth = effectiveWidth - horizontalPadding - totalBorder;
      if (newWidth > curWidth) {
        newSize.width = Math.max(150, Math.round(newWidth));
        sizeChanged = true;
      }
    } else {
      textSizerWidth = curWidth - horizontalPadding - totalBorder;
    }
    textSizer.style.width = `${textSizerWidth}px`;
    const newHeight = textSizer.scrollHeight + verticalPadding + totalBorder;
    if (isNaN(curHeight) || Math.abs(newHeight - curHeight) > 1) {
      newSize.height = Math.round(newHeight);
      sizeChanged = true;
    }
    if (isTexting && textarea) {
      const newInnerHeight = newHeight - verticalPadding - totalBorder;
      textarea.style.height = `${newInnerHeight}px`;
      textarea.scrollTop = textarea.scrollHeight;
    }
    if (sizeChanged && !isNaN(newSize.height)) { // Thêm check isNaN
      updateNodeSize(id, newSize);
    }
  }, [
    displayLabel,
    isTexting,
    id,
    updateNodeSize,
    data.style.width,
    data.style.height,
    data.style.fontSize,
    data.style.fontFamily,
    data.style.fontWeight,
    data.style.fontStyle,
    data.style.border
  ]);


  // --- (Logic Style - Đã Sửa Lỗi Độ Mờ Viền) ---
  const {
    border,
    opacity, // Opacity tổng thể
    backgroundColor,
    backgroundOpacity,
    borderOpacity, // Opacity CỦA VIỀN (mới)
    ...restOfStyle
  } = data.style || {};

  const showBorder = border && border !== 'none';
  const [borderWidth, borderStyleStr, borderColor] = showBorder ? String(border).split(' ') : ['0px', 'solid', '#000'];

  const nodeStyle = {
    ...restOfStyle,
    width: data.style?.width || 180,
    height: data.style?.height || 'auto',
    borderWidth: showBorder ? parseInt(borderWidth) : 0,
    borderStyle: showBorder ? borderStyleStr : 'none',
    // Dùng 'borderOpacity' cho viền
    borderColor: showBorder ? hexToRgba(borderColor, borderOpacity ?? 1) : 'transparent',
    position: 'relative',
    boxSizing: 'border-box',
    // Dùng 'backgroundOpacity' cho nền
    backgroundColor: hexToRgba(backgroundColor || '#ffffff', backgroundOpacity ?? 1),
    // Dùng 'opacity' cho tổng thể
    opacity: opacity ?? 1,
    paddingTop: data.icon ? '35px' : '10px',
  };

  const wrapperStyle = {
    width: nodeStyle.width,
    height: nodeStyle.height,
  };

  const renderIcon = () => {
    if (!data.icon) return null;
    if (isImageUrl(data.icon)) {
      return <img src={data.icon} className="node-icon image" alt="icon" />;
    }
    return <div className="node-icon emoji">{data.icon}</div>;
  };
  // --- Hết logic style ---


  // --- (Logic Render Node Giả) ---
  if (id === FAKE_NODE_ID) {
    return (
      <CustomNodeToolbar
        nodeId={id}
        data={data}
        isVisible={selected && !isEditing}
      />
    );
  }

  // --- (Logic Render Node Thật) ---
  const isSingleSelected = selected && selectedNodeIds.length === 1;

  return (
    <div
      className={`custom-node-wrapper ${isTexting ? 'editing' : ''} ${selected ? 'selected' : ''}`}
      style={wrapperStyle}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <NodeResizer
        isVisible={selected && !isTexting}
        minWidth={150}
        onResizeStart={() => setIsEditing(true)}
        onResize={handleResize}
        onResizeEnd={() => setIsEditing(false)}
        keepAspectRatio={false}
        handleLeft={true}
        handleRight={true}
        handleTop={false}
        handleBottom={false}
        handleTopLeft={false}
        handleTopRight={false}
        handleBottomLeft={false}
        handleBottomRight={false}
        handleClassName="node-resizer-handle"
        lineClassName="node-resizer-line"
      />

      <div
        className="custom-node"
        style={nodeStyle}
      >
        <CustomNodeToolbar
          nodeId={id}
          data={data}
          isVisible={isSingleSelected && !isEditing}
        />

        {renderIcon()}
        <div className="node-label">{data.label || '...'}</div>
        <textarea
          ref={textareaRef}
          value={displayLabel}
          onChange={handleTextChange}
          // ...
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="node-label-input"
          style={{
            fontSize: nodeStyle.fontSize,
            fontFamily: nodeStyle.fontFamily,
            fontWeight: nodeStyle.fontWeight,
            fontStyle: nodeStyle.fontStyle,
            color: nodeStyle.color,
            top: data.icon ? '35px' : '10px',
            height: data.icon ? 'calc(100% - 45px)' : 'calc(100% - 20px)',
          }}
        />
        <div ref={textSizerRef} className="text-sizer" aria-hidden="true" />
      </div>

      <Handle type="target" position={targetPosition || Position.Left} />
      <Handle type="source" position={sourcePosition || Position.Right} />

      {(isHovered || selected) && !isTexting && (
        <>
          <button
            className="add-node-button left"
            onClick={(e) => handleAddNode(e, 'left')}
            onDoubleClick={(e) => e.stopPropagation()}
          >+</button>

          <button
            className="add-node-button right"
            onClick={(e) => handleAddNode(e, 'right')}
            onDoubleClick={(e) => e.stopPropagation()}
          >+</button>
        </>
      )}

    </div>
  );
}

export default memo(CustomNode);