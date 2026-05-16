const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 180;
const PREVIEW_PADDING = 14;
const MAX_FALLBACK_ITEMS = 450;
const MAX_LABEL_LENGTH = 90;

const DEFAULT_THUMBNAILS = new Set([
  '/images/default-mindmap-thumbnail.png',
  '/images/default-mindmap-thumbnail.svg',
]);

const LEVEL_STYLES = {
  1: { fill: '#dff7ff', stroke: '#168aad' },
  2: { fill: '#ffe2e2', stroke: '#d94848' },
  3: { fill: '#dcfce7', stroke: '#2f9e44' },
  4: { fill: '#fff3bf', stroke: '#f08c00' },
  5: { fill: '#ede9fe', stroke: '#7048e8' },
  6: { fill: '#f1f3f5', stroke: '#495057' },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function truncateLabel(value, maxLength = 18) {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  if (!label) return 'Mindmap';
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}...` : label;
}

function normalizeThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || DEFAULT_THUMBNAILS.has(trimmed)) return '';
  if (trimmed.startsWith('data:image/')) return '';
  return trimmed;
}

function getNodeLabel(node) {
  return (
    node?.data?.label ||
    node?.label ||
    node?.title ||
    node?.id ||
    'Mindmap'
  );
}

function extractBorderColor(border, fallback) {
  if (typeof border !== 'string') return fallback;
  const match = border.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)\s*$/i);
  return match ? match[1] : fallback;
}

function estimateNodeHeight(label, width, fontSize, minHeight = 34) {
  const usableWidth = Math.max(48, width - 40);
  const charsPerLine = Math.max(8, Math.floor(usableWidth / Math.max(fontSize * 0.58, 7)));
  const lineCount = Math.max(1, Math.ceil(String(label || '').length / charsPerLine));
  return Math.max(minHeight, Math.round(lineCount * fontSize * 1.25 + 22));
}

function getNodeSize(node) {
  const style = node?.data?.style || {};
  const label = getNodeLabel(node);
  const fontSize = toFiniteNumber(style.fontSize, 14);
  const fallbackWidth = node?.type === 'drawArea'
    ? 320
    : clamp(Math.round(String(label).length * fontSize * 0.6 + 58), 150, 260);

  const width = clamp(
    toFiniteNumber(node?.width, null) ??
      toFiniteNumber(node?.measured?.width, null) ??
      toFiniteNumber(style.width, null) ??
      toFiniteNumber(node?.data?.width, null) ??
      fallbackWidth,
    36,
    1600
  );

  const minHeight = node?.type === 'drawArea' ? 90 : 32;
  const fallbackHeight = node?.type === 'drawArea'
    ? 220
    : estimateNodeHeight(label, width, fontSize, minHeight);

  const height = clamp(
    toFiniteNumber(node?.height, null) ??
      toFiniteNumber(node?.measured?.height, null) ??
      toFiniteNumber(style.height, null) ??
      toFiniteNumber(node?.data?.height, null) ??
      fallbackHeight,
    20,
    1600
  );

  return { width, height, fontSize };
}

function getLevelStyles(level, node) {
  const fallback = LEVEL_STYLES[Math.min(level, 6)] || LEVEL_STYLES[6];
  const style = node?.data?.style || {};
  return {
    fill: style.backgroundColor || fallback.fill,
    stroke: extractBorderColor(style.border, fallback.stroke),
  };
}

function createNodeLevels(nodes, edges) {
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const childMap = new Map();
  const incoming = new Set();

  if (Array.isArray(edges)) {
    edges.forEach((edge) => {
      const source = String(edge?.source || '');
      const target = String(edge?.target || '');
      if (!nodeIds.has(source) || !nodeIds.has(target)) return;
      if (!childMap.has(source)) childMap.set(source, []);
      childMap.get(source).push(target);
      incoming.add(target);
    });
  }

  const roots = nodes.filter((node) => !incoming.has(String(node.id)));
  const queue = (roots.length ? roots : nodes).map((node) => ({
    id: String(node.id),
    level: 1,
  }));
  const levels = new Map();

  while (queue.length) {
    const current = queue.shift();
    if (levels.has(current.id)) continue;
    levels.set(current.id, current.level);
    (childMap.get(current.id) || []).forEach((childId) => {
      queue.push({ id: childId, level: current.level + 1 });
    });
  }

  nodes.forEach((node) => {
    const id = String(node.id);
    if (!levels.has(id)) levels.set(id, 1);
  });

  return levels;
}

function createRawNodesFromPositionedNodes(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const levels = createNodeLevels(nodes, edges);

  return nodes.map((node) => {
    const id = String(node.id);
    const position = node.positionAbsolute || node.position || {};
    const x = toFiniteNumber(position.x, null);
    const y = toFiniteNumber(position.y, null);
    if (x === null || y === null) return null;

    const level = Math.min(levels.get(id) || 1, 6);
    const { width, height, fontSize } = getNodeSize(node);
    const style = getLevelStyles(level, node);

    return {
      id,
      label: getNodeLabel(node),
      level,
      x,
      y,
      width,
      height,
      fontSize,
      type: node.type || 'custom',
      ...style,
    };
  }).filter(Boolean);
}

function createRawLinks(edges, nodeMap) {
  if (!Array.isArray(edges)) return [];

  return edges.map((edge) => {
    const sourceId = String(edge?.source || '');
    const targetId = String(edge?.target || '');
    if (!nodeMap.has(sourceId) || !nodeMap.has(targetId)) return null;
    return {
      sourceId,
      targetId,
      stroke: edge?.style?.stroke || 'rgba(78, 93, 120, 0.42)',
    };
  }).filter(Boolean);
}

function getBounds(nodes) {
  return nodes.reduce((bounds, node) => ({
    minX: Math.min(bounds.minX, node.x),
    minY: Math.min(bounds.minY, node.y),
    maxX: Math.max(bounds.maxX, node.x + node.width),
    maxY: Math.max(bounds.maxY, node.y + node.height),
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  });
}

function getAnchors(source, target) {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };

  if (targetCenter.x >= sourceCenter.x) {
    return {
      x1: source.x + source.width,
      y1: sourceCenter.y,
      x2: target.x,
      y2: targetCenter.y,
    };
  }

  return {
    x1: source.x,
    y1: sourceCenter.y,
    x2: target.x + target.width,
    y2: targetCenter.y,
  };
}

function fitRawPreview(rawNodes, rawLinks) {
  if (!rawNodes.length) return { nodes: [], links: [] };

  const bounds = getBounds(rawNodes);
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = PREVIEW_WIDTH - PREVIEW_PADDING * 2;
  const availableHeight = PREVIEW_HEIGHT - PREVIEW_PADDING * 2;
  const scale = clamp(
    Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight),
    0.02,
    2.4
  );
  const offsetX = (PREVIEW_WIDTH - boundsWidth * scale) / 2 - bounds.minX * scale;
  const offsetY = (PREVIEW_HEIGHT - boundsHeight * scale) / 2 - bounds.minY * scale;

  const transformX = (value) => value * scale + offsetX;
  const transformY = (value) => value * scale + offsetY;

  const nodes = rawNodes.map((node) => {
    const x = transformX(node.x);
    const y = transformY(node.y);
    const width = Math.max(node.width * scale, node.type === 'drawArea' ? 3 : 5);
    const height = Math.max(node.height * scale, node.type === 'drawArea' ? 3 : 4);
    const fontSize = clamp(node.fontSize * scale * 0.72, 4.5, 11);
    const maxChars = Math.floor(width / Math.max(fontSize * 0.56, 3));
    const label = width >= 26 && height >= 12 && maxChars >= 3
      ? truncateLabel(node.label, Math.min(MAX_LABEL_LENGTH, Math.max(3, maxChars)))
      : '';

    return {
      id: node.id,
      label,
      level: node.level,
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
      textX: round(x + width / 2),
      textY: round(y + height / 2),
      fontSize: round(fontSize),
      radius: round(clamp(Math.min(width, height) * 0.18, 1.5, 8)),
      strokeWidth: round(clamp(2 * scale, 0.6, 2)),
      fill: node.fill,
      stroke: node.stroke,
    };
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const links = rawLinks.map((link) => {
    const source = nodeMap.get(link.sourceId);
    const target = nodeMap.get(link.targetId);
    if (!source || !target) return null;

    const { x1, y1, x2, y2 } = getAnchors(source, target);
    const midX = (x1 + x2) / 2;
    return {
      d: `M ${round(x1)} ${round(y1)} C ${round(midX)} ${round(y1)}, ${round(midX)} ${round(y2)}, ${round(x2)} ${round(y2)}`,
      stroke: link.stroke,
      strokeWidth: round(clamp(2.2 * scale, 0.5, 2.4)),
    };
  }).filter(Boolean);

  return { nodes, links };
}

function createPreviewFromPositionedNodes(nodes, edges) {
  const rawNodes = createRawNodesFromPositionedNodes(nodes, edges);
  if (rawNodes.length !== nodes.length) return null;
  const rawNodeMap = new Map(rawNodes.map((node) => [node.id, node]));
  const rawLinks = createRawLinks(edges, rawNodeMap);
  return fitRawPreview(rawNodes, rawLinks);
}

function createItemsFromNodes(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const limitedNodes = nodes.slice(0, MAX_FALLBACK_ITEMS);
  const nodeMap = new Map(limitedNodes.map((node) => [String(node.id), node]));
  const childMap = new Map();
  const incoming = new Set();

  if (Array.isArray(edges)) {
    edges.forEach((edge) => {
      const source = String(edge?.source || '');
      const target = String(edge?.target || '');
      if (!nodeMap.has(source) || !nodeMap.has(target)) return;
      if (!childMap.has(source)) childMap.set(source, []);
      childMap.get(source).push(target);
      incoming.add(target);
    });
  }

  const roots = limitedNodes.filter((node) => !incoming.has(String(node.id)));
  const queue = (roots.length ? roots : [limitedNodes[0]]).map((node) => ({
    id: String(node.id),
    parentId: null,
    level: 1,
  }));
  const items = [];
  const visited = new Set();

  while (queue.length && items.length < MAX_FALLBACK_ITEMS) {
    const current = queue.shift();
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const node = nodeMap.get(current.id);
    if (!node) continue;

    items.push({
      id: current.id,
      parentId: current.parentId,
      level: Math.min(current.level, 6),
      label: getNodeLabel(node),
    });

    (childMap.get(current.id) || []).forEach((childId) => {
      queue.push({ id: childId, parentId: current.id, level: current.level + 1 });
    });
  }

  return items;
}

function getMarkdownLevel(line, currentDepth) {
  const trimmed = line.trim();
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return {
      level: Math.min(headingMatch[1].length, 6),
      label: headingMatch[2],
    };
  }

  const bulletMatch = line.match(/^(\s*)[-*\u2022\u2666]\s+(.+)$/);
  if (bulletMatch) {
    return {
      level: Math.min(Math.floor(bulletMatch[1].length / 2) + 2, 6),
      label: bulletMatch[2],
    };
  }

  const orderedMatch = trimmed.match(/^([0-9]+|[a-z]|[ivxlcdm]+)[.)-]\s+(.+)$/i);
  if (orderedMatch) {
    return {
      level: Math.min(currentDepth + 1 || 2, 6),
      label: orderedMatch[2],
    };
  }

  return {
    level: Math.min(currentDepth || 1, 6),
    label: trimmed.replace(/^>\s*/, ''),
  };
}

function createItemsFromMarkdown(content, fallbackTitle) {
  const lines = typeof content === 'string'
    ? content.split(/\r?\n/).filter((line) => line.trim()).slice(0, MAX_FALLBACK_ITEMS)
    : [];

  if (lines.length === 0) {
    return [{
      id: 'preview-root',
      parentId: null,
      level: 1,
      label: fallbackTitle || 'Mindmap',
    }];
  }

  const items = [];
  const stack = [];

  lines.forEach((line, index) => {
    const parsed = getMarkdownLevel(line, stack.length || 1);
    const level = index === 0 ? 1 : Math.max(parsed.level, 2);
    const id = `md-${index}`;
    let parentId = null;

    if (level > 1) {
      for (let parentLevel = level - 1; parentLevel >= 1; parentLevel -= 1) {
        if (stack[parentLevel]) {
          parentId = stack[parentLevel];
          break;
        }
      }
      parentId = parentId || items[0]?.id || null;
    }

    items.push({
      id,
      parentId,
      level,
      label: parsed.label,
    });

    stack[level] = id;
    stack.splice(level + 1);
  });

  return items;
}

function getItemSize(item) {
  const width = item.level === 1 ? 220 : 190;
  const fontSize = item.level === 1 ? 16 : 14;
  return {
    width,
    height: estimateNodeHeight(item.label, width, fontSize, item.level === 1 ? 46 : 38),
    fontSize,
  };
}

function layoutTreePreview(items) {
  if (!items.length) return { nodes: [], links: [] };

  const itemMap = new Map(items.map((item) => [item.id, item]));
  const childrenByParent = new Map();
  items.forEach((item) => {
    if (!item.parentId || !itemMap.has(item.parentId)) return;
    if (!childrenByParent.has(item.parentId)) childrenByParent.set(item.parentId, []);
    childrenByParent.get(item.parentId).push(item);
  });

  const roots = items.filter((item) => !item.parentId || !itemMap.has(item.parentId));
  const rawNodes = [];
  const rawNodeMap = new Map();
  const rawLinks = [];
  let nextY = 0;

  function layoutItem(item, depth) {
    const children = childrenByParent.get(item.id) || [];
    const { width, height, fontSize } = getItemSize(item);
    const childYs = children.map((child) => layoutItem(child, depth + 1));
    const y = childYs.length
      ? (Math.min(...childYs) + Math.max(...childYs)) / 2
      : nextY;

    if (!childYs.length) nextY += 86;

    const level = Math.min(item.level || depth + 1, 6);
    const style = LEVEL_STYLES[level] || LEVEL_STYLES[6];
    const rawNode = {
      id: item.id,
      label: item.label,
      level,
      x: depth * 260,
      y: y - height / 2,
      width,
      height,
      fontSize,
      type: 'custom',
      ...style,
    };
    rawNodes.push(rawNode);
    rawNodeMap.set(item.id, rawNode);
    return y;
  }

  roots.forEach((root) => {
    layoutItem(root, 0);
    nextY += 42;
  });

  items.forEach((item) => {
    if (!item.parentId || !rawNodeMap.has(item.parentId) || !rawNodeMap.has(item.id)) return;
    rawLinks.push({
      sourceId: item.parentId,
      targetId: item.id,
      stroke: 'rgba(78, 93, 120, 0.42)',
    });
  });

  return fitRawPreview(rawNodes, rawLinks);
}

function buildMindmapPreview(mindmap) {
  let preview = null;

  if (Array.isArray(mindmap?.nodes) && mindmap.nodes.length > 0) {
    preview = createPreviewFromPositionedNodes(mindmap.nodes, mindmap?.edges);
    if (!preview) {
      preview = layoutTreePreview(createItemsFromNodes(mindmap.nodes, mindmap?.edges));
    }
  } else {
    preview = layoutTreePreview(createItemsFromMarkdown(mindmap?.content, mindmap?.title));
  }

  return {
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    nodes: preview?.nodes || [],
    links: preview?.links || [],
  };
}

function decorateMindmap(mindmap) {
  return {
    ...mindmap,
    thumbnailUrl: normalizeThumbnailUrl(mindmap?.thumbnailUrl),
    preview: buildMindmapPreview(mindmap),
  };
}

function decorateMindmaps(mindmaps) {
  if (!Array.isArray(mindmaps)) return [];
  return mindmaps.map(decorateMindmap);
}

module.exports = {
  buildMindmapPreview,
  decorateMindmap,
  decorateMindmaps,
};
