// File: components/RemoteCursor.jsx
import React from 'react';
import { useReactFlow } from '@xyflow/react';
import './RemoteCursor.scss';

const RemoteCursor = ({ cursors }) => {
  const reactFlowInstance = useReactFlow();
  
  if (!cursors || cursors.size === 0) return null;

  // Random colors cho mỗi user
  const getColor = (userId) => {
    const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#87d068', '#ff6b6b', '#4ecdc4'];
    const index = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[index % colors.length];
  };

  return (
    <>
      {Array.from(cursors.entries()).map(([userId, cursor]) => {
        // ✅ Convert flow position to screen position
        const screenPos = reactFlowInstance?.flowToScreenPosition({ x: cursor.x, y: cursor.y }) || { x: 0, y: 0 };
        
        return (
          <div
            key={userId}
            className="remote-cursor"
            style={{
              left: screenPos.x,
              top: screenPos.y,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}
            >
              {/* Mouse pointer arrow */}
              <path
                d="M2 2L2 14L6 10L9 16L11 15L8 9L13 9L2 2Z"
                fill={getColor(userId)}
                stroke="white"
                strokeWidth="0.5"
              />
            </svg>
            <div className="cursor-label" style={{ backgroundColor: getColor(userId) }}>
              {cursor.username}
            </div>
          </div>
        );
      })}
    </>
  );
};

export default RemoteCursor;
