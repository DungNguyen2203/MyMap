import React, { memo, useState, useEffect, useRef } from 'react';
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

const adjustHeight = (el) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};


function CustomNode({ id, data, selected }) {
  // --- (Lấy state và actions từ store) ---
  const selectedNodeIds = useStore(s => s.selectedNodeIds);
  const { updateNodeData, updateNodeSize, addMindMapNode, setNodeDraggable } = useStore();

  // --- (State local của component) ---
  const [isEditing, setIsEditing] = useState(false);
  const [isTexting, setIsTexting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const [label, setLabel] = useState(data.label);
  const [pointsText, setPointsText] = useState('');

  const titleTextareaRef = useRef(null);
  const pointsTextareaRef = useRef(null);
  const textSizerRef = useRef(null);

  // --- (Các hàm xử lý sự kiện: resize, double-click, blur, keydown) ---
  const handleResize = (event, params) => {
    updateNodeSize(id, { width: params.width });
  };
  const handleDoubleClick = (e) => {
    e.stopPropagation();
    setIsEditing(true);
    setIsTexting(true);
  };
  const handleBlur = (e) => {
    if (e && e.currentTarget && e.relatedTarget) {
      const nodeElement = e.currentTarget.closest('.custom-node');
      if (nodeElement && nodeElement.contains(e.relatedTarget)) {
        return;
      }
    }

    const updatedFields = {};
    if (data.label !== label) {
      updatedFields.label = label;
    }
    
    const parsedPoints = pointsText
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean);
    
    const oldPointsStr = JSON.stringify(data.points || []);
    const newPointsStr = JSON.stringify(parsedPoints);
    if (oldPointsStr !== newPointsStr) {
      updatedFields.points = parsedPoints;
    }
    
    if (Object.keys(updatedFields).length > 0) {
      updateNodeData(id, updatedFields);
    }
    setIsEditing(false);
    setIsTexting(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.target === titleTextareaRef.current) {
        e.preventDefault();
        handleBlur(e);
      }
    }
  };

  // Đồng bộ hóa points từ props
  useEffect(() => {
    if (data.points) {
      setPointsText(data.points.join('\n'));
    } else {
      setPointsText('');
    }
  }, [data.points]);

  // Focus và điều chỉnh độ cao ban đầu của các textareas
  useEffect(() => {
    if (isTexting) {
      adjustHeight(titleTextareaRef.current);
      adjustHeight(pointsTextareaRef.current);
      
      const t = titleTextareaRef.current;
      if (t) {
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
        t.scrollTop = t.scrollHeight;
      }
    }
  }, [isTexting]);

  useEffect(() => {
    setNodeDraggable(id, !isEditing);
  }, [isEditing, id, setNodeDraggable]);

  useEffect(() => {
    setLabel(data.label);
  }, [data.label]);

  // --- (Hàm thêm node con) ---
  const handleAddNode = (e, direction) => {
    e.stopPropagation();
    const sourceNode = useStore.getState().nodes.find(n => n.id === id);
    if (sourceNode) addMindMapNode(sourceNode, direction);
  };

  // --- (useEffect tự động Sizing) ---
  useEffect(() => {
    const textSizer = textSizerRef.current;
    if (!textSizer) return;
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
    
    const currentText = (isTexting ? label : data.label) || ' ';
    const currentPoints = isTexting
      ? (pointsText ? pointsText.split('\n').filter(Boolean) : [])
      : (data.points || []);

    if (currentPoints.length > 0) {
      const pointsHtml = currentPoints.map(pt => `<li style="margin-bottom:3px; word-break:break-word;">${pt}</li>`).join('');
      textSizer.innerHTML = `<div style="word-break:break-word;">${currentText}</div><ul style="margin-top:6px; padding-left:15px; font-size:11px; list-style-type:disc; line-height:1.3; color:${s.color || '#333'}">${pointsHtml}</ul>`;
    } else {
      textSizer.textContent = currentText + '\u200B';
    }

    const newSize = {};
    let sizeChanged = false;
    
    // Luôn giữ nguyên width của node khi hiển thị lẫn khi soạn thảo, tránh tình trạng bị rộng ra
    const textSizerWidth = curWidth - horizontalPadding - totalBorder;
    textSizer.style.width = `${textSizerWidth}px`;
    
    const newHeight = textSizer.scrollHeight + verticalPadding + totalBorder;
    if (isNaN(curHeight) || Math.abs(newHeight - curHeight) > 1) {
      newSize.height = Math.round(newHeight);
      sizeChanged = true;
    }
    
    if (isTexting) {
      adjustHeight(titleTextareaRef.current);
      adjustHeight(pointsTextareaRef.current);
    }
    
    if (sizeChanged && !isNaN(newSize.height)) {
      updateNodeSize(id, newSize);
    }
  }, [
    label,
    pointsText,
    data.label,
    data.points,
    isTexting,
    isEditing,
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
        
        {isTexting ? (
          <div className="node-edit-container" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <textarea
              ref={titleTextareaRef}
              value={label}
              onChange={(e) => {
                const val = e.target.value;
                setLabel(val);
                updateNodeData(id, { label: val });
                adjustHeight(e.target);
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className="node-label-edit-textarea nodrag"
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                resize: 'none',
                overflow: 'hidden',
                textAlign: 'center',
                fontSize: nodeStyle.fontSize,
                fontFamily: nodeStyle.fontFamily,
                fontWeight: nodeStyle.fontWeight,
                fontStyle: nodeStyle.fontStyle,
                color: nodeStyle.color || '#111',
                padding: 0,
                margin: 0,
                lineHeight: '1.35',
              }}
            />
            {(data.points || pointsText) && (
              <>
                <div style={{ borderTop: '1px dashed rgba(0,0,0,0.15)', width: '100%', height: '1px', margin: '4px 0' }} />
                <textarea
                  ref={pointsTextareaRef}
                  value={pointsText}
                  placeholder="Nhập các ý chính (mỗi dòng một ý)..."
                  onChange={(e) => {
                    const val = e.target.value;
                    setPointsText(val);
                    adjustHeight(e.target);
                  }}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  className="node-points-edit-textarea nodrag"
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    resize: 'none',
                    overflow: 'hidden',
                    textAlign: 'left',
                    fontSize: '11px',
                    fontFamily: nodeStyle.fontFamily || 'Arial',
                    color: nodeStyle.color || '#333',
                    padding: '0 0 0 10px',
                    margin: 0,
                    lineHeight: '1.3',
                  }}
                />
              </>
            )}
          </div>
        ) : (
          <>
            <div className="node-label">{data.label || '...'}</div>
            {data.points && data.points.length > 0 && (
              <ul className="node-points-list" style={{ 
                marginTop: '6px', 
                paddingLeft: '15px', 
                fontSize: '11px', 
                textAlign: 'left', 
                opacity: 0.85,
                borderTop: '1px dashed rgba(0,0,0,0.15)',
                paddingTop: '6px',
                listStyleType: 'disc',
                color: nodeStyle.color || '#333',
                fontFamily: nodeStyle.fontFamily || 'Arial',
                lineHeight: '1.3'
              }}>
                {data.points.map((point, index) => (
                  <li key={index} style={{ marginBottom: '3px', wordBreak: 'break-word' }}>{point}</li>
                ))}
              </ul>
            )}
          </>
        )}
        
        <div ref={textSizerRef} className="text-sizer" aria-hidden="true" />
      </div>

      {/* Target handle: where parent connects */}
      {!(data.isRoot || id === 'node-1') && (
        <Handle 
          type="target" 
          position={data.isLeft ? Position.Right : Position.Left} 
          id="target" 
        />
      )}

      {/* Source handle(s): where children connect */}
      {(data.isRoot || id === 'node-1') ? (
        <>
          <Handle type="source" position={Position.Right} id="source-right" />
          <Handle type="source" position={Position.Left} id="source-left" />
        </>
      ) : (
        <Handle 
          type="source" 
          position={data.isLeft ? Position.Left : Position.Right} 
          id="source" 
        />
      )}

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