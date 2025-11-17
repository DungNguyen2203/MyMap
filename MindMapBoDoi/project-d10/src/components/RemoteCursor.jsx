// File: components/RemoteCursor.jsx
import React from 'react';
import './RemoteCursor.scss';

const RemoteCursor = ({ cursors }) => {
  if (!cursors || cursors.size === 0) return null;

  // Random colors cho mỗi user
  const getColor = (userId) => {
    const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#87d068', '#ff6b6b', '#4ecdc4'];
    const index = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[index % colors.length];
  };

  return (
    <>
      {Array.from(cursors.entries()).map(([userId, cursor]) => (
        <div
          key={userId}
          className="remote-cursor"
          style={{
            left: cursor.x,
            top: cursor.y,
            borderColor: getColor(userId),
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ filter: `drop-shadow(0 2px 4px ${getColor(userId)}40)` }}
          >
            <path
              d="M5.65376 12.3673L12.4916 5.52959L13.7137 12.2022L18.2625 14.3339L5.65376 12.3673Z"
              fill={getColor(userId)}
            />
          </svg>
          <div className="cursor-label" style={{ backgroundColor: getColor(userId) }}>
            {cursor.username}
          </div>
        </div>
      ))}
    </>
  );
};

export default RemoteCursor;
