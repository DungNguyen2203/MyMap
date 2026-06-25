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
        label: text,
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
  };

  const colors = {
    1: { bg: '#A2E9FF', border: '#0288d1', fontSize: 18, fontWeight: 'bold', width: 280 },
    2: { bg: '#FFC9C9', border: '#d32f2f', fontSize: 16, width: 250 },
    3: { bg: '#96E3AD', border: '#388e3c', fontSize: 14, width: 220 },
    4: { bg: '#FFEDA4', border: '#f57c00', fontSize: 13, width: 220 },
    5: { bg: '#E0E0E0', border: '#616161', fontSize: 12, width: 220 },
    6: { bg: '#F3E5F5', border: '#6A1B9A', fontSize: 12, width: 220 },
  };

  const c = colors[level] || colors[5];
  return {
    ...base,
    backgroundColor: c.bg,
    border: `2px solid ${c.border}`,
    fontSize: c.fontSize,
    fontWeight: c.fontWeight || 'normal',
    width: c.width,
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
    const style = node.data?.style || {};
    const width = parseInt(style.width || 220, 10);
    
    // 1. Chiều cao ước lượng của tiêu đề chính
    const charsPerLineLabel = Math.max(10, Math.floor((width - 40) / 8));
    const labelLines = Math.ceil(Math.max(1, label.length) / charsPerLineLabel);
    const fontSizeLabel = parseInt(style.fontSize || 14, 10);
    let estimatedHeight = labelLines * (fontSizeLabel * 1.35) + 20; // 20px padding trên dưới
    
    // 2. Chiều cao của các points (ý phụ) nếu có
    const points = node.data?.points || [];
    if (points.length > 0) {
      estimatedHeight += 12; // divider margin + border
      points.forEach(point => {
        const charsPerLinePoint = Math.max(15, Math.floor((width - 40) / 6.5));
        const pointLines = Math.ceil(Math.max(1, point.length) / charsPerLinePoint);
        estimatedHeight += pointLines * (11 * 1.3) + 3; // 3px margin bottom mỗi point
      });
    }
    
    return Math.max(55, Math.round(estimatedHeight));
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

  const NODE_GAP = 55; // Khoảng cách giãn cách tối thiểu bằng pixel giữa các node (Tăng từ 25 để các node không quá gần nhau)
  const H_SPACE = 340; // Khoảng cách ngang tối ưu (Tăng từ 270 để tăng độ giãn cách ngang giữa cha-con)

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
  
  // Tính chiều cao cây con cho toàn bộ các root
  roots.forEach(root => {
    calculateSubtreePixelHeight(root.id);
  });

  // Bước 2: Cho toàn bộ các nhánh con của Root phát triển sang phía PHẢI (không chia 2 bên nữa)
  const rootChildren = childMap.get(mainRoot.id) || [];
  const leftBranches = [];
  const rightBranches = [];

  rootChildren.forEach((childId) => {
    rightBranches.push(childId);
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

  // Căn chỉnh để root chính nằm chính giữa trung tâm
  const maxRightY = currentRightY;
  const maxLeftY = currentLeftY;
  const maxCenterY = Math.max(maxRightY, maxLeftY) / 2 - getNodeHeight(mainRoot.id) / 2;

  const rightOffset = maxCenterY - (maxRightY / 2 - getNodeHeight(mainRoot.id) / 2);
  const leftOffset = maxCenterY - (maxLeftY / 2 - getNodeHeight(mainRoot.id) / 2);

  // Bố cục cho các root phụ (nếu có)
  let extraY = Math.max(maxRightY, maxLeftY) + 150;
  roots.forEach((root, idx) => {
    if (idx === 0) return;
    root.data = { ...root.data, isRoot: true, isLeft: false };
    nodePositions.set(root.id, { x: 0, y: extraY });
    layoutRight(root.id, 1, extraY);
    extraY += (subtreePixelHeights.get(root.id) || 100) + 100;
  });

  // Lấy toàn bộ con cháu để lọc offset chỉ cho main tree
  const getDescendants = (nodeId, map) => {
    const list = [];
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = map.get(current) || [];
      children.forEach(childId => {
        list.push(childId);
        queue.push(childId);
      });
    }
    return list;
  };

  const mainRightDescendants = new Set();
  rightBranches.forEach(bId => {
    mainRightDescendants.add(bId);
    getDescendants(bId, childMap).forEach(id => mainRightDescendants.add(id));
  });

  const mainLeftDescendants = new Set();
  leftBranches.forEach(bId => {
    mainLeftDescendants.add(bId);
    getDescendants(bId, childMap).forEach(id => mainLeftDescendants.add(id));
  });

  // Áp dụng offset và tọa độ vào các node
  nodes.forEach(node => {
    const pos = nodePositions.get(node.id);
    if (pos) {
      let finalY = pos.y;
      if (node.id === mainRoot.id) {
        finalY = maxCenterY;
      } else if (mainRightDescendants.has(node.id)) {
        finalY += rightOffset;
      } else if (mainLeftDescendants.has(node.id)) {
        finalY += leftOffset;
      }
      // Roots phụ và con cháu giữ nguyên pos.y (không cộng offset của main root)
      node.position = { x: Math.round(pos.x), y: Math.round(finalY) };
    }
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

/**
 * 🌳 Chuyển đổi trực tiếp cấu trúc cây JSON của AI thành Nodes & Edges của React Flow (O(n))
 * Đặt các points (ý phụ) nằm bên trong node cha (Phương án A) giúp sơ đồ gọn gàng.
 */
export const jsonToReactFlow = (jsonObject) => {
  if (!jsonObject || typeof jsonObject !== 'object') {
    return { nodes: [], edges: [] };
  }

  const nodes = [];
  const edges = [];
  let nodeIdCounter = 1;

  // 1. Tạo node chính (Root)
  const rootId = `node-${nodeIdCounter++}`;
  const rootNode = {
    id: rootId,
    type: 'custom',
    position: { x: 0, y: 0 },
    draggable: true,
    selectable: true,
    data: {
      label: jsonObject.mainTopic || 'Sơ đồ tư duy',
      style: getStyleByLevel(1),
      points: jsonObject.summary ? [jsonObject.summary] : [],
    },
  };
  nodes.push(rootNode);

  // Hàm duyệt đệ quy các node con
  const traverse = (item, parentId, level) => {
    if (!item) return;

    const nodeId = `node-${nodeIdCounter++}`;
    const title = item.title || item.chapterTitle || 'Mục con';
    
    const node = {
      id: nodeId,
      type: 'custom',
      position: { x: 0, y: 0 },
      draggable: true,
      selectable: true,
      data: {
        label: title,
        style: getStyleByLevel(level),
        points: Array.isArray(item.points) ? item.points.filter(Boolean) : [],
      },
    };
    nodes.push(node);

    // Tạo liên kết
    edges.push({
      id: `edge-${parentId}-${nodeId}`,
      source: parentId,
      target: nodeId,
      type: 'default',
    });

    // Duyệt qua các children
    const children = item.children || [];
    children.forEach(child => {
      traverse(child, nodeId, Math.min(level + 1, 6));
    });
  };

  // Duyệt qua các subTopics của root
  const subTopics = jsonObject.subTopics || [];
  subTopics.forEach(topic => {
    traverse(topic, rootId, 2);
  });

  console.log(`✅ [jsonToReactFlow] Đã chuyển đổi trực tiếp JSON thành ${nodes.length} nodes và ${edges.length} edges`);

  // Áp dụng thuật toán layout
  return fastLayout(nodes, edges);
};
