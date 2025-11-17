// File: components/CollaborativeAvatars.jsx
import React from 'react';
import { Avatar, Tooltip } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import './CollaborativeAvatars.scss';

const CollaborativeAvatars = ({ users }) => {
  if (!users || users.length === 0) return null;

  // Random colors cho mỗi user
  const getColor = (userId) => {
    const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#87d068', '#ff6b6b', '#4ecdc4'];
    const index = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[index % colors.length];
  };

  return (
    <div className="collaborative-avatars">
      <div className="avatars-list">
        {users.map((user) => (
          <Tooltip key={user.userId} title={user.username} placement="bottom">
            <Avatar
              size={36}
              style={{
                backgroundColor: getColor(user.userId),
                cursor: 'pointer',
                marginLeft: -8,
                border: '2px solid white'
              }}
              icon={<UserOutlined />}
            >
              {user.username ? user.username[0].toUpperCase() : 'U'}
            </Avatar>
          </Tooltip>
        ))}
      </div>
      <div className="online-count">
        {users.length} người đang online
      </div>
    </div>
  );
};

export default CollaborativeAvatars;
