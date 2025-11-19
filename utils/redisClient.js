// utils/redisClient.js
const Redis = require('ioredis');

// Support cả local và Render Redis URL
let redisConfig;

if (process.env.REDIS_URL) {
  // Render/Production: Dùng Redis URL (format: redis://user:pass@host:port)
  redisConfig = process.env.REDIS_URL;
  console.log('📍 Using Redis URL from environment');
} else {
  // Local development
  redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  };
  console.log('📍 Using local Redis configuration');
}

// Khởi tạo Redis client với lazyConnect để không crash app
const redis = new Redis(redisConfig, {
  lazyConnect: true, // Không tự động connect, app sẽ không crash nếu Redis fail
  retryStrategy: (times) => {
    if (times > 3) {
      console.log('⚠️ Redis reconnection attempts stopped');
      return null; // Stop retrying
    }
    const delay = Math.min(times * 1000, 3000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  connectTimeout: 5000,
  enableOfflineQueue: false, // Không queue commands khi offline
});

// Attempt to connect to Redis
let isRedisConnected = false;

redis.connect()
  .then(() => {
    console.log('✅ Redis connected successfully!');
    isRedisConnected = true;
  })
  .catch((err) => {
    console.error('⚠️ Redis connection failed:', err.message);
    console.log('⚠️ App will continue without Redis (jobs will use in-memory fallback)');
    isRedisConnected = false;
  });

redis.on('connect', () => {
  console.log('✅ Redis connected successfully!');
  isRedisConnected = true;
});

redis.on('error', (err) => {
  console.error('⚠️ Redis error:', err.message);
  isRedisConnected = false;
});

redis.on('close', () => {
  console.log('⚠️ Redis connection closed');
  isRedisConnected = false;
});

// Job Manager sử dụng Redis với fallback
class JobManager {
  constructor(redisClient) {
    this.redis = redisClient;
    this.JOB_TTL = 10 * 60; // 10 phút
    this.inMemoryJobs = new Map(); // Fallback khi Redis không có
  }

  isRedisAvailable() {
    return isRedisConnected && this.redis.status === 'ready';
  }

  async createJob(jobId, jobData) {
    if (this.isRedisAvailable()) {
      try {
        const key = `job:${jobId}`;
        await this.redis.setex(key, this.JOB_TTL, JSON.stringify(jobData));
        console.log(`📝 Job created in Redis: ${jobId}`);
        return jobId;
      } catch (err) {
        console.error('⚠️ Redis createJob failed, using in-memory:', err.message);
      }
    }
    
    // Fallback to in-memory
    this.inMemoryJobs.set(jobId, { ...jobData, createdAt: Date.now() });
    console.log(`📝 Job created in-memory: ${jobId}`);
    return jobId;
  }

  async getJob(jobId) {
    if (this.isRedisAvailable()) {
      try {
        const key = `job:${jobId}`;
        const data = await this.redis.get(key);
        if (data) return JSON.parse(data);
      } catch (err) {
        console.error('⚠️ Redis getJob failed, using in-memory:', err.message);
      }
    }
    
    // Fallback to in-memory
    return this.inMemoryJobs.get(jobId) || null;
  }

  async updateJob(jobId, updates) {
    if (this.isRedisAvailable()) {
      try {
        const key = `job:${jobId}`;
        const existing = await this.getJob(jobId);
        if (!existing) {
          throw new Error(`Job ${jobId} not found`);
        }
        const updated = { ...existing, ...updates };
        await this.redis.setex(key, this.JOB_TTL, JSON.stringify(updated));
        return updated;
      } catch (err) {
        console.error('⚠️ Redis updateJob failed, using in-memory:', err.message);
      }
    }
    
    // Fallback to in-memory
    const existing = this.inMemoryJobs.get(jobId);
    if (!existing) {
      throw new Error(`Job ${jobId} not found`);
    }
    const updated = { ...existing, ...updates };
    this.inMemoryJobs.set(jobId, updated);
    return updated;
  }

  async deleteJob(jobId) {
    if (this.isRedisAvailable()) {
      try {
        const key = `job:${jobId}`;
        await this.redis.del(key);
        console.log(`🗑️ Job deleted from Redis: ${jobId}`);
        return;
      } catch (err) {
        console.error('⚠️ Redis deleteJob failed, using in-memory:', err.message);
      }
    }
    
    // Fallback to in-memory
    this.inMemoryJobs.delete(jobId);
    console.log(`🗑️ Job deleted from in-memory: ${jobId}`);
  }

  async getAllJobIds() {
    if (this.isRedisAvailable()) {
      try {
        const keys = await this.redis.keys('job:*');
        return keys.map(k => k.replace('job:', ''));
      } catch (err) {
        console.error('⚠️ Redis getAllJobIds failed, using in-memory:', err.message);
      }
    }
    
    // Fallback to in-memory
    return Array.from(this.inMemoryJobs.keys());
  }
}

const jobManager = new JobManager(redis);

module.exports = { redis, jobManager };
