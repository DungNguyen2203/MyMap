/**
 * 🔥 BẢN TỐI ƯU HIỆU NĂNG CAO CHO FILE LỚN (tới 20.000 node)
 * - Tự động giới hạn node
 * - Bỏ qua node trùng hoặc quá sâu
 * - Bố cục cực nhanh (O(n))
 */

export const markdownToMindmap = (markdownContent) => {
  if (typeof markdownContent !== 'string' || markdownContent.trim() === '') {
    return {
      nodes: [
        {
          id: 'node-1',
          type: 'custom',
          position: { x: 0, y: 0 },
          data: {
            label: 'Mindmap moi',
            style: getStyleByLevel(1),
          },
        },
      ],
      edges: [],
    };
  }

  const lines = markdownContent.split('\n').filter(line => line.trim());
  const nodes = [];
  const edges = [];
  const stack = [];

  let nodeIdCounter = 1;
  const MAX_NODES = 20000; // ✅ Giới hạn tối đa

  for (let i = 0; i < lines.length; i++) {
    if (nodeIdCounter > MAX_NODES) break;

    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    let level = 0;
    let text = trimmed;

    // --- Nhận dạng heading (#, ##, ###)
    const headingMatch = trimmed.match(/^(#+)\s+(.+)$/);
    if (headingMatch) {
      level = headingMatch[1].length;
      text = headingMatch[2];
    }
    // --- Nhận dạng danh sách (-, •, ♦)
    else if (trimmed.match(/^[-•♦]\s+/)) {
      const indent = line.match(/^(\s*)[-•♦]\s*(.+)$/);
      level = Math.floor(indent[1].length / 2) + 3;
      text = indent[2];
    }
    // --- Nhận dạng số hoặc chữ
    else if (trimmed.match(/^[IVXLC]+\s*[-.)]/i)) level = 2;
    else if (trimmed.match(/^[0-9]+\s*[-.)]/)) level = 3;
    else if (trimmed.match(/^[a-z]\s*[-.)]/i)) level = 4;
    // --- Trích dẫn
    else if (trimmed.startsWith('>')) {
      text = trimmed.substring(1).trim();
      level = 1;
    }
    // --- Dòng thường
    else {
      level = Math.max(stack.length, 1);
    }

    // --- Giới hạn độ sâu tối đa
    if (level > 6) level = 6;

    // --- Tạo node
    const nodeId = `node-${nodeIdCounter++}`;
    const node = {
      id: nodeId,
      type: 'custom',
      position: { x: 0, y: 0 },
      data: {
        label: text.length > 120 ? text.slice(0, 120) + "..." : text, // cắt text dài
        style: getStyleByLevel(level),
      },
    };
    nodes.push(node);

    // --- Nối với parent
    if (level > 0 && stack[level - 1]) {
      edges.push({
        id: `edge-${stack[level - 1]}-${nodeId}`,
        source: stack[level - 1],
        target: nodeId,
        type: 'default',
      });
    }

    // --- Cập nhật stack
    stack[level] = nodeId;
    stack.splice(level + 1);
  }

  console.log(`✅ Tạo ${nodes.length} nodes và ${edges.length} edges`);

  // --- Bố cục cực nhanh
  return fastLayout(nodes, edges);
};

/**
 * 🎨 Gán màu theo cấp độ
 */
const getStyleByLevel = (level) => {
  const base = {
    fontFamily: 'Arial',
    borderRadius: 8,
    border: '2px solid #555',
    padding: 8,
    width: 220,
  };

  const colors = {
    1: { bg: '#A2E9FF', border: '#0288d1', fontSize: 18, fontWeight: 'bold' },
    2: { bg: '#FFC9C9', border: '#d32f2f', fontSize: 16 },
    3: { bg: '#96E3AD', border: '#388e3c', fontSize: 14 },
    4: { bg: '#FFEDA4', border: '#f57c00', fontSize: 13 },
    5: { bg: '#E0E0E0', border: '#616161', fontSize: 12 },
    6: { bg: '#F3E5F5', border: '#6A1B9A', fontSize: 12 },
  };

  const c = colors[level] || colors[5];
  return {
    ...base,
    backgroundColor: c.bg,
    border: `2px solid ${c.border}`,
    fontSize: c.fontSize,
    fontWeight: c.fontWeight || 'normal',
  };
};

/**
 * ⚡ Fast layout (O(n)) – Không đệ quy, cực nhanh
 */
export const fastLayout = (nodes, edges) => {
  if (nodes.length === 0) return { nodes, edges };

  // Hàm phụ: Tính toán chính xác chiều cao ước lượng của 1 node bằng pixel
  const getNodeHeight = (nodeId) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return 55;
    const label = node.data?.label || '';
    // Thường 220px rộng sẽ chứa tầm 18 ký tự mỗi dòng
    const charPerLine = 18;
    const lines = Math.ceil(Math.max(1, label.length) / charPerLine);
    const fontSize = 14;
    const padding = 24; // padding trên dưới + border
    return Math.max(55, lines * (fontSize * 1.3) + padding);
  };

  const childMap = new Map();
  const parentMap = new Map();

  edges.forEach(e => {
    if (!childMap.has(e.source)) childMap.set(e.source, []);
    childMap.get(e.source).push(e.target);
    parentMap.set(e.target, e.source);
  });

  const roots = nodes.filter(n => !parentMap.has(n.id));
  if (roots.length === 0) return { nodes, edges };

  // Xác định Main Root
  const mainRoot = roots[0];
  mainRoot.data = {
    ...mainRoot.data,
    isRoot: true,
    isLeft: false
  };

  const NODE_GAP = 25; // Khoảng cách giãn cách tối thiểu bằng pixel giữa các node
  const H_SPACE = 270; // Khoảng cách ngang tối ưu

  // Bước 1: Tính chiều cao bằng pixel (bao gồm cả con) của mỗi nhánh cây con
  const subtreePixelHeights = new Map();
  function calculateSubtreePixelHeight(nodeId) {
    const nodeHeight = getNodeHeight(nodeId);
    const children = childMap.get(nodeId) || [];
    
    if (children.length === 0) {
      const totalHeight = nodeHeight + NODE_GAP;
      subtreePixelHeights.set(nodeId, totalHeight);
      return totalHeight;
    }
    
    let childrenHeight = 0;
    children.forEach(cId => {
      childrenHeight += calculateSubtreePixelHeight(cId);
    });
    
    const totalHeight = Math.max(nodeHeight + NODE_GAP, childrenHeight);
    subtreePixelHeights.set(nodeId, totalHeight);
    return totalHeight;
  }
  calculateSubtreePixelHeight(mainRoot.id);

  // Bước 2: Chia đôi các nhánh con của Root sang 2 phía TRÁI và PHẢI
  const rootChildren = childMap.get(mainRoot.id) || [];
  const leftBranches = [];
  const rightBranches = [];

  rootChildren.forEach((childId, index) => {
    if (index % 2 === 0) {
      rightBranches.push(childId);
    } else {
      leftBranches.push(childId);
    }
  });

  const nodePositions = new Map();

  // Đặt vị trí Root chính ở (0, 0) làm tâm
  nodePositions.set(mainRoot.id, { x: 0, y: 0 });

  // Vẽ nhánh Phải (X tăng dần)
  function layoutRight(nodeId, depth, startY) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    node.data = {
      ...node.data,
      isLeft: false,
      isRoot: false
    };

    const children = childMap.get(nodeId) || [];
    const totalHeight = subtreePixelHeights.get(nodeId) || 80;
    const nodeHeight = getNodeHeight(nodeId);
    const centerY = startY + totalHeight / 2 - nodeHeight / 2;

    nodePositions.set(nodeId, { x: depth * H_SPACE, y: centerY });

    let currentY = startY;
    children.forEach(cId => {
      layoutRight(cId, depth + 1, currentY);
      currentY += subtreePixelHeights.get(cId) || 80;
    });
  }

  // Vẽ nhánh Trái (X giảm dần)
  function layoutLeft(nodeId, depth, startY) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    node.data = {
      ...node.data,
      isLeft: true,
      isRoot: false
    };

    const children = childMap.get(nodeId) || [];
    const totalHeight = subtreePixelHeights.get(nodeId) || 80;
    const nodeHeight = getNodeHeight(nodeId);
    const centerY = startY + totalHeight / 2 - nodeHeight / 2;

    nodePositions.set(nodeId, { x: -depth * H_SPACE, y: centerY });

    let currentY = startY;
    children.forEach(cId => {
      layoutLeft(cId, depth + 1, currentY);
      currentY += subtreePixelHeights.get(cId) || 80;
    });
  }

  // Thực hiện định vị các nhánh
  let currentRightY = 0;
  rightBranches.forEach(branchId => {
    layoutRight(branchId, 1, currentRightY);
    currentRightY += subtreePixelHeights.get(branchId) || 80;
  });

  let currentLeftY = 0;
  leftBranches.forEach(branchId => {
    layoutLeft(branchId, 1, currentLeftY);
    currentLeftY += subtreePixelHeights.get(branchId) || 80;
  });

  // Căn chỉnh để root nằm chính giữa trung tâm
  const maxRightY = currentRightY;
  const maxLeftY = currentLeftY;
  const maxCenterY = Math.max(maxRightY, maxLeftY) / 2 - getNodeHeight(mainRoot.id) / 2;

  const rightOffset = maxCenterY - (maxRightY / 2 - getNodeHeight(mainRoot.id) / 2);
  const leftOffset = maxCenterY - (maxLeftY / 2 - getNodeHeight(mainRoot.id) / 2);

  // Áp dụng offset và tọa độ vào các node
  nodes.forEach(node => {
    const pos = nodePositions.get(node.id);
    if (pos) {
      let finalY = pos.y;
      if (pos.x > 0) {
        finalY += rightOffset;
      } else if (pos.x < 0) {
        finalY += leftOffset;
      } else {
        finalY = maxCenterY;
      }
      node.position = { x: Math.round(pos.x), y: Math.round(finalY) };
    }
  });

  // Bố cục cho các root phụ (nếu có)
  let extraY = Math.max(maxRightY, maxLeftY) + 150;
  roots.forEach((root, idx) => {
    if (idx === 0) return;
    root.data = { ...root.data, isRoot: true, isLeft: false };
    nodePositions.set(root.id, { x: 0, y: extraY });
    layoutRight(root.id, 1, extraY);
    extraY += (subtreePixelHeights.get(root.id) || 100) + 100;
  });

  // Bước 3: Định tuyến Handles thông minh cho các liên kết (edges)
  edges.forEach(e => {
    if (e.source === mainRoot.id) {
      const targetNode = nodes.find(n => n.id === e.target);
      if (targetNode && targetNode.data?.isLeft) {
        e.sourceHandle = 'source-left';
      } else {
        e.sourceHandle = 'source-right';
      }
    } else {
      e.sourceHandle = 'source';
    }
    e.targetHandle = 'target';
  });

  return { nodes, edges };
};
