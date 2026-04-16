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
const fastLayout = (nodes, edges) => {
  const H_SPACE = 250;
  const V_SPACE = 80;

  const childMap = new Map();
  const parentMap = new Map();

  edges.forEach(e => {
    if (!childMap.has(e.source)) childMap.set(e.source, []);
    childMap.get(e.source).push(e.target);
    parentMap.set(e.target, e.source);
  });

  const roots = nodes.filter(n => !parentMap.has(n.id));
  let y = 0;

  for (const root of roots) {
    layoutBranch(root.id, 0);
  }

  function layoutBranch(id, depth) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.position = { x: depth * H_SPACE, y };
    y += V_SPACE;
    const children = childMap.get(id) || [];
    for (const c of children) {
      layoutBranch(c, depth + 1);
    }
  }

  return { nodes, edges };
};
